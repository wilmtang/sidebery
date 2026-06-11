import { AnyFunc, Actions, Message, ActionsKeys, ActionsType, IPCNodeInfo } from 'src/types'
import { InstanceType } from 'src/enums'
import { rmFromArray } from 'src/utils'
import { NOID } from 'src/defaults'
import * as Logs from 'src/services/logs'
import * as Info from 'src/services/info'

export interface PortNameData {
  srcType: InstanceType
  dstType: InstanceType
  srcWinId?: ID
  dstWinId?: ID
  srcTabId?: ID
  dstTabId?: ID
}

const enum ConnectionState {
  Closed = 0,
  Connecting = 1,
  Ready = 2,
}

interface PendingRequest {
  request: () => void
  err: (err?: any) => void
}

export interface ConnectionInfo {
  type: InstanceType
  /**
   * - NOID (-1) for background
   * - Window id for sidebar and popup
   * - Tab id for content scripts
   */
  id: ID
  state: ConnectionState
  pendingRequests: PendingRequest[]
  pendingSendings: (() => void)[]
  reconnectCount: number
  reconnectingTimeout?: number
  /**
   * Port from browser.runtime.connect()
   */
  localPort?: browser.runtime.Port
  /**
   * Port from browser.runtime.onConnect event
   */
  remotePort?: browser.runtime.Port
  disconnectListener?: (port: browser.runtime.Port) => void
  postListener?: <T extends InstanceType, A extends keyof Actions>(msg: Message<T, A>) => void
  /**
   * Pending connection-confirmation waiter for THIS connection attempt.
   * Kept per-connection (not in the shared msgsWaitingForAnswer map) so that
   * concurrent connectTo() calls from one context don't clobber each other.
   */
  conConfirmTimeout?: number
  conConfirmResolve?: () => void
}

interface MsgWaitingForAnswer {
  timeout: number
  ok?: (v?: any) => void
  err?: (err?: any) => void
  /**
   * The actual local Port the request was sent on. Matched by identity (not by
   * name) on disconnect: port names are deterministic per src/dst pair and thus
   * identical across reconnects, so name-matching would reject in-flight
   * requests belonging to a freshly reconnected port.
   */
  port?: browser.runtime.Port
}

const MSG_CONFIRM_DEADLINE = 60_000
const CONNECT_CONFIRM_DEADLINE = 5_000
const INCR_TIMEOUT_STEP = 1_000
const RECON_COUNT = 6
const RESET_RECON_COUNT_TIMEOUT = CONNECT_CONFIRM_DEADLINE + INCR_TIMEOUT_STEP * (RECON_COUNT + 2)

let actions: Actions | undefined
let _localType = InstanceType.unknown
let _localWinId = NOID
let _localTabId = NOID

export const state = {
  bgConnection: undefined as ConnectionInfo | undefined,
  searchPopupConnections: new Map<ID, ConnectionInfo>(),
  editingPopupConnections: new Map<ID, ConnectionInfo>(),
  sidebarConnections: new Map<ID, ConnectionInfo>(),
  setupPageConnections: new Map<ID, ConnectionInfo>(),
  groupPageConnections: new Map<ID, ConnectionInfo>(),
  syncConnections: new Map<ID, ConnectionInfo>(),
  panelConfigConnections: new Map<ID, ConnectionInfo>(),
  previewConnection: undefined as ConnectionInfo | undefined,
}

export function setInstanceType(type: InstanceType): void {
  _localType = type
}

export function setWinId(id: ID): void {
  _localWinId = id
}

export function setTabId(id: ID): void {
  _localTabId = id
}

export function registerActions(a: Actions): void {
  actions = a
}

export function getInfo(): IPCNodeInfo {
  return { type: _localType, winId: _localWinId, tabId: _localTabId }
}

export function isConnected(type: InstanceType, id = NOID): boolean {
  if (type === InstanceType.bg && state.bgConnection) return true
  else if (type === InstanceType.sidebar) return state.sidebarConnections.has(id)
  else if (type === InstanceType.setup) return state.setupPageConnections.has(id)
  else if (type === InstanceType.search) return state.searchPopupConnections.has(id)
  else if (type === InstanceType.editing) return state.editingPopupConnections.has(id)
  else if (type === InstanceType.group) return state.groupPageConnections.has(id)
  else if (type === InstanceType.sync) return state.syncConnections.has(id)
  else if (type === InstanceType.panelConfig) return state.panelConfigConnections.has(id)
  else if (type === InstanceType.preview && state.previewConnection) return true
  return false
}

export function getConnection(type: InstanceType, id: ID): ConnectionInfo | undefined {
  if (type === InstanceType.bg && state.bgConnection) return state.bgConnection
  else if (type === InstanceType.sidebar) return state.sidebarConnections.get(id)
  else if (type === InstanceType.setup) return state.setupPageConnections.get(id)
  else if (type === InstanceType.search) return state.searchPopupConnections.get(id)
  else if (type === InstanceType.editing) return state.editingPopupConnections.get(id)
  else if (type === InstanceType.group) return state.groupPageConnections.get(id)
  else if (type === InstanceType.sync) return state.syncConnections.get(id)
  else if (type === InstanceType.panelConfig) return state.panelConfigConnections.get(id)
  else if (type === InstanceType.preview) return state.previewConnection
}

function removeConnection(type: InstanceType, id: ID) {
  // Logs.info('IPC.REMOVE:', getInstanceName(type), id)
  // Clear any pending connection-confirmation timer so it can't fire on a
  // connection that's being torn down.
  const existing = getConnection(type, id)
  if (existing?.conConfirmTimeout !== undefined) {
    clearTimeout(existing.conConfirmTimeout)
    existing.conConfirmTimeout = undefined
    existing.conConfirmResolve = undefined
  }
  if (type === InstanceType.bg) state.bgConnection = undefined
  else if (type === InstanceType.sidebar) state.sidebarConnections.delete(id)
  else if (type === InstanceType.setup) state.setupPageConnections.delete(id)
  else if (type === InstanceType.search) state.searchPopupConnections.delete(id)
  else if (type === InstanceType.editing) state.editingPopupConnections.delete(id)
  else if (type === InstanceType.sync) state.syncConnections.delete(id)
  else if (type === InstanceType.panelConfig) state.panelConfigConnections.delete(id)
  else if (type === InstanceType.group) state.groupPageConnections.delete(id)
  else if (type === InstanceType.preview) state.previewConnection = undefined
}

function createConnection(type: InstanceType, id: ID): ConnectionInfo {
  const connection = {
    type,
    id,
    state: ConnectionState.Closed,
    pendingRequests: [],
    pendingSendings: [],
    reconnectCount: 0,
  }
  if (type === InstanceType.bg) state.bgConnection = connection
  else if (type === InstanceType.sidebar) state.sidebarConnections.set(id, connection)
  else if (type === InstanceType.setup) state.setupPageConnections.set(id, connection)
  else if (type === InstanceType.search) state.searchPopupConnections.set(id, connection)
  else if (type === InstanceType.editing) state.editingPopupConnections.set(id, connection)
  else if (type === InstanceType.group) state.groupPageConnections.set(id, connection)
  else if (type === InstanceType.sync) state.syncConnections.set(id, connection)
  else if (type === InstanceType.panelConfig) state.panelConfigConnections.set(id, connection)
  else if (type === InstanceType.preview) state.previewConnection = connection
  return connection
}

/**
 * Connects current instance to another instance.
 */
// let connectingTimeout: number | undefined
export function connectTo(
  dstType: InstanceType,
  dstWinId = NOID,
  dstTabId = NOID
): browser.runtime.Port | undefined {
  const srcType = _localType
  const srcWinId = _localWinId
  const srcTabId = _localTabId
  const toBg = dstType === InstanceType.bg
  const toSidebar = dstType === InstanceType.sidebar
  const toSetup = dstType === InstanceType.setup
  const toSearch = dstType === InstanceType.search
  const toEditing = dstType === InstanceType.editing
  const toSync = dstType === InstanceType.sync
  const toPanelConfig = dstType === InstanceType.panelConfig
  const toGroup = dstType === InstanceType.group
  const toPreview = dstType === InstanceType.preview
  const dbgPrefix = `IPC.connectTo(${Info.getInstanceName(dstType)}):`

  // Check destination id
  let id
  if (toBg || toPreview) id = NOID
  else if ((toSidebar || toSearch || toEditing || toSync || toPanelConfig) && dstWinId !== NOID) {
    id = dstWinId
  } else if ((toSetup || toGroup) && dstTabId !== NOID) id = dstTabId
  else {
    Logs.err(`${dbgPrefix} No destination id`)
    return
  }

  // Create port name
  const portNameData: PortNameData = { srcType, dstType }
  if (srcWinId !== NOID) portNameData.srcWinId = srcWinId
  if (srcTabId !== NOID) portNameData.srcTabId = srcTabId
  if (dstWinId !== NOID && (toSidebar || toSearch || toEditing || toSync || toPanelConfig)) {
    portNameData.dstWinId = dstWinId
  }
  if (dstTabId !== NOID && (toSetup || toGroup)) portNameData.dstTabId = dstTabId
  const portNameJson = JSON.stringify(portNameData)

  // Find/Create connection
  let connection: ConnectionInfo
  let connectionIsNew = false
  const existedConnection = getConnection(dstType, id)
  if (existedConnection) {
    connection = existedConnection

    // Already connecting
    if (connection.state === ConnectionState.Connecting) {
      Logs.warn(`${dbgPrefix} Already connecting...`)
      return
    }
  } else {
    connectionIsNew = true
    connection = createConnection(dstType, id)
  }
  if (connection.state !== ConnectionState.Ready) {
    connection.state = ConnectionState.Connecting
  }

  if (connection.localPort) connection.localPort.disconnect()
  connection.localPort = browser.runtime.connect({ name: portNameJson })

  // Handle messages
  connection.postListener = <T extends InstanceType, A extends keyof Actions>(
    msg: Message<T, A>
  ) => {
    onPostMsg(msg, connection.localPort, connection)
  }
  connection.localPort.onMessage.addListener(connection.postListener)

  // Handle disconnect
  connection.disconnectListener = (port: browser.runtime.Port) => {
    Logs.info(`${dbgPrefix} Disconnected!`, port.name, port.error?.message)

    port.onMessage.removeListener(connection.postListener)
    port.onDisconnect.removeListener(connection.disconnectListener)

    // Remove port
    connection.localPort = undefined

    // Run disconnection handlers
    if (!connection.remotePort) {
      const handlers = disconnectionHandlers.get(dstType)
      if (handlers) handlers.forEach(cb => cb(connection.id))
    }

    // Reconnect to background
    if (toBg && connection.reconnectCount++ < RECON_COUNT) {
      clearTimeout(connection.reconnectingTimeout)
      const timeout = INCR_TIMEOUT_STEP * connection.reconnectCount
      Logs.info(`${dbgPrefix} Reconnecting...`, timeout)
      connection.state = ConnectionState.Closed
      connection.reconnectingTimeout = setTimeout(() => connectTo(dstType, dstWinId), timeout)

      // Clear confirmation timeout of the previous connection attempt
      if (connection.conConfirmTimeout !== undefined) {
        clearTimeout(connection.conConfirmTimeout)
        connection.conConfirmTimeout = undefined
        connection.conConfirmResolve = undefined
      }
    }

    // Remove connection
    else {
      resolveUnfinishedCommunications(port)

      Logs.info(`${dbgPrefix} Removing connection`)
      if (!connection.remotePort) {
        connection.state = ConnectionState.Closed
        removeConnection(dstType, id)
      }
    }
  }
  connection.localPort.onDisconnect.addListener(connection.disconnectListener)

  // Reset reconnection count after RESET_RECON_COUNT_TIMEOUT
  clearTimeout(connection.reconnectingTimeout)
  connection.reconnectingTimeout = setTimeout(() => {
    // Logs.info(`${dbgPrefix} Reseting reconnection count:`, connection.reconnectCount)
    connection.reconnectCount = 0
  }, RESET_RECON_COUNT_TIMEOUT)

  // Wait confirmation
  const conConfirmTimeout = CONNECT_CONFIRM_DEADLINE + INCR_TIMEOUT_STEP * connection.reconnectCount
  const timeout = setTimeout(() => {
    Logs.info(`${dbgPrefix} No confirmation for ${conConfirmTimeout}ms`)

    connection.conConfirmTimeout = undefined
    connection.conConfirmResolve = undefined

    connection.state = ConnectionState.Closed

    // Retry or give up
    if (toBg && connection.reconnectCount++ < RECON_COUNT) {
      Logs.info(`${dbgPrefix} Retrying connection...`, connection.reconnectCount)
      connectTo(dstType, dstWinId)
    } else {
      Logs.warn(`${dbgPrefix} Unable to reconnect...`, connection.reconnectCount)
      removeConnection(dstType, id)
      if (connection.pendingRequests.length) {
        connection.pendingRequests.forEach(pending => pending.err('No connection confirmation'))
        connection.pendingRequests = []
      }
    }
  }, conConfirmTimeout)

  connection.conConfirmTimeout = timeout
  connection.conConfirmResolve = () => {
    // Logs.info(`IPC.connectTo(${getInstanceName(dstType)}): CONFIRMED`)
    connection.state = ConnectionState.Ready
    if (connectionIsNew) {
      const handlers = connectionHandlers.get(dstType)
      if (handlers) handlers.forEach(cb => cb(connection.id))
      triggerConnectionAwaiters(dstType, connection.id)
    }
    if (connection.pendingRequests.length) {
      const pending = connection.pendingRequests
      connection.pendingRequests = []
      pending.forEach(pending => pending.request())
    }
  }

  return connection.localPort
}

/**
 * Sends message to sidebar.
 */
export function sidebar<T extends InstanceType.sidebar, A extends ActionsKeys<T>>(
  dstWinId: ID,
  action: A,
  ...args: Parameters<ActionsType<T>[A]>
): Promise<ReturnType<ActionsType<T>[A]>> {
  const msg: Message<T, A> = { dstType: InstanceType.sidebar, dstWinId, action, args }
  return request(msg, AutoConnectMode.WithRetry)
}
export function sendToSidebar<T extends InstanceType.sidebar, A extends ActionsKeys<T>>(
  dstWinId: ID,
  action: A,
  ...args: Parameters<ActionsType<T>[A]>
): void {
  send({ dstType: InstanceType.sidebar, dstWinId, action, args })
}

/**
 * Sends message to all connected sidebars.
 */
export function sidebars<T extends InstanceType.sidebar, A extends ActionsKeys<T>>(
  action: A,
  ...args: Parameters<ActionsType<T>[A]>
): Promise<ReturnType<ActionsType<T>[A]>[]> | undefined {
  const tasks = Array.from(state.sidebarConnections.keys()).map(id => {
    const msg = { dstType: InstanceType.sidebar, dstWinId: id, action, args }
    return request(msg, AutoConnectMode.WithRetry)
  })
  return Promise.all(tasks)
}
export function sendToSidebars<T extends InstanceType.sidebar, A extends ActionsKeys<T>>(
  action: A,
  ...args: Parameters<ActionsType<T>[A]>
): void {
  state.sidebarConnections.forEach(con => {
    send({ dstType: InstanceType.sidebar, dstWinId: con.id, action, args })
  })
}

/**
 * Sends message to setup page.
 */
export function setupPage<T extends InstanceType.setup, A extends ActionsKeys<T>>(
  dstTabId: ID,
  action: A,
  ...args: Parameters<ActionsType<T>[A]>
): Promise<ReturnType<ActionsType<T>[A]>> {
  const msg: Message<T, A> = { dstType: InstanceType.setup, dstTabId, action, args }
  return request(msg, AutoConnectMode.WithRetry)
}

/**
 * Sends message to panel config popup.
 */
export function panelConfigPopup<T extends InstanceType.panelConfig, A extends ActionsKeys<T>>(
  dstWinId: ID,
  action: A,
  ...args: Parameters<ActionsType<T>[A]>
): Promise<ReturnType<ActionsType<T>[A]>> {
  const msg: Message<T, A> = { dstType: InstanceType.panelConfig, dstWinId, action, args }
  return request(msg, AutoConnectMode.WithRetry)
}

/**
 * Sends message to search popup.
 */
export function sendToSearchPopup<T extends InstanceType.search, A extends ActionsKeys<T>>(
  dstWinId: ID,
  action: A,
  ...args: Parameters<ActionsType<T>[A]>
): void {
  send({ dstType: InstanceType.search, dstWinId, action, args })
}

/**
 * Sends message to editing popup.
 */
export function sendToEditingPopup<T extends InstanceType.editing, A extends ActionsKeys<T>>(
  dstWinId: ID,
  action: A,
  ...args: Parameters<ActionsType<T>[A]>
): void {
  send({ dstType: InstanceType.editing, dstWinId, action, args })
}

/**
 * Sends message to background.
 */
export function bg<T extends InstanceType.bg, A extends ActionsKeys<T>>(
  action: A,
  ...args: Parameters<ActionsType<T>[A]>
): Promise<ReturnType<ActionsType<T>[A]>> {
  const msg: Message<T, A> = { dstType: InstanceType.bg, action, args }
  return request(msg, AutoConnectMode.WithRetry)
}
export function sendToBg<T extends InstanceType.bg, A extends ActionsKeys<T>>(
  action: A,
  ...args: Parameters<ActionsType<T>[A]>
) {
  send({ dstType: InstanceType.bg, action, args })
}

/**
 * Sends message to preview.
 */
export function sendToPreview<T extends InstanceType.preview, A extends ActionsKeys<T>>(
  action: A,
  ...args: Parameters<ActionsType<T>[A]>
) {
  send({ dstType: InstanceType.preview, action, args })
}

export function send<T extends InstanceType, A extends ActionsKeys<T>>(msg: Message<T, A>) {
  if (msg.dstType === undefined) return

  let id = NOID
  if (msg.dstType === InstanceType.sidebar && msg.dstWinId !== undefined) id = msg.dstWinId
  else if (msg.dstType === InstanceType.setup && msg.dstTabId !== undefined) id = msg.dstTabId
  else if (msg.dstType === InstanceType.search && msg.dstWinId !== undefined) id = msg.dstWinId
  else if (msg.dstType === InstanceType.editing && msg.dstWinId !== undefined) id = msg.dstWinId
  else if (msg.dstType === InstanceType.group && msg.dstTabId !== undefined) id = msg.dstTabId

  // Get port
  const connection = getConnection(msg.dstType, id)
  const port = getConnectionPortWithoutError(connection)

  if (!port) {
    connection?.pendingSendings.push(() => send(msg))
    return
  }

  try {
    port.postMessage(msg)
  } catch (e) {
    Logs.warn(`IPC.send(${msg.action}): Got error on postMessage`, e)
    connection?.pendingSendings.push(() => send(msg))
  }
}

async function waitForConnectConfirmation(connection: ConnectionInfo) {
  if (connection.state !== ConnectionState.Connecting) return
  return new Promise<void>((ok, err) => {
    connection.pendingRequests.push({ request: ok, err })
  })
}

function getConnectionPortWithoutError(con?: ConnectionInfo) {
  let port = con?.localPort
  if (port?.error) port = undefined
  if (!port && con?.remotePort && !con.remotePort.error) port = con?.remotePort
  return port
}

function getPortErrorMessage(con?: ConnectionInfo) {
  const msg = con?.localPort?.error?.message ?? con?.remotePort?.error?.message
  return msg ? '\n  Port error: ' + msg : ''
}

const enum AutoConnectMode {
  Off = 0,
  On = 1,
  WithRetry = 2,
}
const msgsWaitingForAnswer: Map<ID, MsgWaitingForAnswer> = new Map()
let msgCounter = 1
let uidCounter = 1

// Receiver-side dedup of re-delivered messages (N11). Keyed by Message.uid.
interface ProcessedMsgEntry {
  done: boolean
  result?: any
  error?: any
  // Answers owed to duplicate deliveries that arrived while the action was
  // still running; each is answered (with the eventual result) on completion.
  pendingAnswers: { id: ID; port: browser.runtime.Port }[]
  cleanupTimeout?: number
}
const processedMsgs = new Map<string, ProcessedMsgEntry>()
// Must outlive the retry deadline so a resend still finds the cached result.
const PROCESSED_MSG_TTL = MSG_CONFIRM_DEADLINE * 2

function finalizeProcessedMsg(uid: string | undefined, result: any, error: any): void {
  if (uid === undefined) return
  const entry = processedMsgs.get(uid)
  if (!entry) return

  entry.done = true
  entry.result = result
  entry.error = error

  // Answer duplicate deliveries that queued while the action was running.
  for (const pending of entry.pendingAnswers) {
    try {
      pending.port.postMessage({ id: pending.id, result, error })
    } catch {
      /* port may be dead */
    }
  }
  entry.pendingAnswers = []

  clearTimeout(entry.cleanupTimeout)
  entry.cleanupTimeout = setTimeout(() => processedMsgs.delete(uid), PROCESSED_MSG_TTL)
}
/**
 * Send message using port.postMessage and wait for answer
 */
export async function request<T extends InstanceType, A extends ActionsKeys<T>>(
  msg: Message<T, A>,
  autoConnectMode: AutoConnectMode
): Promise<ReturnType<ActionsType<T>[A]>> {
  if (msg.dstType === undefined) return Promise.reject('IPC.request: No dstType')
  const dstType = msg.dstType
  const dbgPrefix = `IPC.request ${Info.getInstanceName(dstType)}: ${msg.action}:`

  let id = NOID
  if (dstType === InstanceType.sidebar && msg.dstWinId !== undefined) id = msg.dstWinId
  else if (dstType === InstanceType.setup && msg.dstTabId !== undefined) id = msg.dstTabId
  else if (dstType === InstanceType.search && msg.dstWinId !== undefined) id = msg.dstWinId
  else if (dstType === InstanceType.editing && msg.dstWinId !== undefined) id = msg.dstWinId
  else if (dstType === InstanceType.sync && msg.dstWinId !== undefined) id = msg.dstWinId
  else if (dstType === InstanceType.panelConfig && msg.dstWinId !== undefined) id = msg.dstWinId
  else if (dstType === InstanceType.group && msg.dstTabId !== undefined) id = msg.dstTabId

  // Get connection and port
  let connection = getConnection(dstType, id)
  let port = getConnectionPortWithoutError(connection)

  return new Promise(async (ok, err) => {
    // No connection, or no port, or closed state = try to connect
    if (!connection || !port || connection.state === ConnectionState.Closed) {
      Logs.info(`${dbgPrefix} No port, or closed state`)

      if (autoConnectMode === AutoConnectMode.Off) {
        return err(dbgPrefix + ' No connection or port' + getPortErrorMessage(connection))
      }

      if (autoConnectMode === AutoConnectMode.WithRetry) {
        Logs.warn(`${dbgPrefix} No port, or closed state, trying to connect...`)
        connectTo(dstType, msg.dstWinId, msg.dstTabId)

        connection = getConnection(dstType, id)
        if (!connection) return err(`${dbgPrefix} Auto-connection: No connection`)

        Logs.info(`${dbgPrefix} Pending request`)
        try {
          await waitForConnectConfirmation(connection)
          connection = getConnection(dstType, id)
          port = getConnectionPortWithoutError(connection)

          if (!connection || !port || connection.state !== ConnectionState.Ready) {
            return err(dbgPrefix + ' Connection is not ready' + getPortErrorMessage(connection))
          }
        } catch (e) {
          return err(e)
        }
      } else {
        return err(`${dbgPrefix} Cannot get target port${getPortErrorMessage(connection)}`)
      }
    }

    // Connection is not ready
    else if (connection.state !== ConnectionState.Ready) {
      Logs.info(`${dbgPrefix} Connection is not ready: Pending request`)
      try {
        await waitForConnectConfirmation(connection)
        connection = getConnection(dstType, id)
        port = getConnectionPortWithoutError(connection)

        if (!connection || !port || connection.state !== ConnectionState.Ready) {
          return err(dbgPrefix + ' Connection is not ready')
        }
      } catch (e) {
        return err(e)
      }
    }

    // Set message id
    const msgId = msgCounter++
    msg.id = msgId

    // Assign a retry-stable uid once (kept across resends because the retry
    // re-sends this same `msg` object). Lets the receiver dedupe re-deliveries.
    if (msg.uid === undefined) {
      msg.uid = `${_localType}:${_localWinId}:${_localTabId}:${uidCounter++}`
    }

    // Send the message
    try {
      port.postMessage(msg)
    } catch (e) {
      if (autoConnectMode === AutoConnectMode.WithRetry) {
        Logs.warn(`${dbgPrefix} Got error on postMessage, trying to reconnect...`, e)

        connection.state = ConnectionState.Closed
        connectTo(dstType, msg.dstWinId, msg.dstTabId)
        connection = getConnection(dstType, id)
        if (!connection) return err(`${dbgPrefix} Auto-connection: No connection`)

        try {
          await waitForConnectConfirmation(connection)
          connection = getConnection(dstType, id)
          port = getConnectionPortWithoutError(connection)

          if (!connection || !port || connection.state !== ConnectionState.Ready) {
            return err(dbgPrefix + ' Connection is not ready')
          }
        } catch (e) {
          return err(e)
        }

        try {
          port.postMessage(msg)
        } catch (e) {
          return err(`${dbgPrefix} Cannot post message: ${String(e)}`)
        }
      } else {
        return err(`${dbgPrefix} Cannot post message: ${String(e)}`)
      }
    }

    // Wait confirmation
    const timeout = setTimeout(() => {
      Logs.warn(`${dbgPrefix} No confirmation:`, Info.getInstanceName(dstType), msg.action)

      msgsWaitingForAnswer.delete(msgId)

      if (autoConnectMode === AutoConnectMode.WithRetry) {
        Logs.info(`${dbgPrefix} Calling request() again...`)
        request(msg, AutoConnectMode.Off).then(ok).catch(err)
      } else {
        if (port) port.error = { message: `${dbgPrefix} No request confirmation/answer` }
        err(`${dbgPrefix} No confirmation`)
      }
    }, MSG_CONFIRM_DEADLINE)

    msgsWaitingForAnswer.set(msgId, { timeout, ok, err, port })
  })
}

/**
 * runtime.sendMessage wrapper.
 */
export function broadcast<T extends InstanceType, A extends ActionsKeys<T>>(
  msg: Message<T, A>
): Promise<ReturnType<ActionsType<T>[A]>> {
  return browser.runtime.sendMessage(msg)
}

/**
 * Handles connection event.
 */
function onConnect(port: browser.runtime.Port) {
  let portNameData: PortNameData | undefined
  try {
    portNameData = JSON.parse(port.name) as PortNameData
  } catch {
    return Logs.err('IPC.onConnect: Cannot parse PortName')
  }
  if (portNameData.dstType !== _localType) return
  if (portNameData.dstWinId !== undefined && portNameData.dstWinId !== _localWinId) return
  // runtime.onConnect fires in every extension context of the right type; a
  // port aimed at a specific tab (setup/group page) must only be accepted by
  // that exact tab, otherwise other same-type pages adopt it too.
  if (portNameData.dstTabId !== undefined && portNameData.dstTabId !== _localTabId) return

  const srcType = portNameData.srcType
  const srcWinId = portNameData.srcWinId ?? NOID
  const srcTabId = portNameData.srcTabId ?? NOID
  const dbgPrefix = `IPC.onConnect(${Info.getInstanceName(srcType)}, ${srcWinId ?? srcTabId}):`
  Logs.info(dbgPrefix)

  // Check connection data
  const fromBg = srcType === InstanceType.bg
  const fromSidebar = srcType === InstanceType.sidebar
  const fromSetup = srcType === InstanceType.setup
  const fromSearch = srcType === InstanceType.search
  const fromEditing = srcType === InstanceType.editing
  const fromGroup = srcType === InstanceType.group
  const fromSync = srcType === InstanceType.sync
  const fromPanelConfig = srcType === InstanceType.panelConfig
  const fromPreview = srcType === InstanceType.preview
  if (fromSidebar && srcWinId === NOID) return Logs.err('IPC.onConnect: Sidebar: No srcWinId')
  if (fromSetup && srcTabId === NOID) return Logs.err('IPC.onConnect: Setup page: No srcTabId')
  if (fromSearch && srcWinId === NOID) return Logs.err('IPC.onConnect: Search popup: No srcWinId')
  if (fromEditing && srcWinId === NOID) return Logs.err('IPC.onConnect: Editing popup: No srcWinId')
  if (fromSync && srcWinId === NOID) return Logs.err('IPC.onConnect: Sync: No srcWinId')
  if (fromPanelConfig && srcWinId === NOID) return Logs.err('IPC.onConnect: PanelConf: No srcWinId')
  if (fromGroup && srcTabId === NOID) return Logs.err('IPC.onConnect: Group page: No srcTabId')

  // Check source id
  let id
  if (fromBg || fromPreview) {
    id = NOID
  } else if (
    (fromSidebar || fromSearch || fromEditing || fromSync || fromPanelConfig) &&
    srcWinId !== NOID
  ) {
    id = srcWinId
  } else if ((fromSetup || fromGroup) && srcTabId !== NOID) {
    id = srcTabId
  } else {
    Logs.err('IPC.onConnect: No source id')
    return
  }

  // Check if new remote port is alive
  try {
    port.postMessage(-99)
  } catch (err) {
    Logs.warn(dbgPrefix, 'New port is already dead...')
    return
  }

  // Find/Create connection
  let connection: ConnectionInfo
  let connectionIsNew = false
  const existedConnection = getConnection(srcType, id)
  if (existedConnection) {
    Logs.info(dbgPrefix, 'Connection already exists')
    connection = existedConnection
  } else {
    Logs.info(dbgPrefix, 'New connection')
    connectionIsNew = true
    connection = createConnection(srcType, id)
  }

  connection.state = ConnectionState.Ready
  connection.remotePort = port

  // Run pending sendings
  if (connection.pendingSendings.length) {
    const pending = connection.pendingSendings
    connection.pendingSendings = []
    pending.forEach(p => p())
  }

  // Run connection handlers
  if (connectionIsNew) {
    const handlers = connectionHandlers.get(srcType)
    if (handlers) handlers.forEach(cb => cb(connection.id))
    triggerConnectionAwaiters(srcType, id)
  }

  // Listen for messages
  const postListener = <T extends InstanceType, A extends keyof Actions>(msg: Message<T, A>) => {
    onPostMsg(msg, port)
  }
  port.onMessage.addListener(postListener)

  // Handle disconnect
  const disconnectListener = (port: browser.runtime.Port) => {
    Logs.info(dbgPrefix, 'Disconnected!', port.name, port.error?.message)

    port.onMessage.removeListener(postListener)
    port.onDisconnect.removeListener(disconnectListener)

    if (!portNameData) return

    resolveUnfinishedCommunications(port)

    // Remove port
    connection.remotePort = undefined

    // Remove connection
    let connectionIsRemoved = false
    if (!connection.localPort) {
      connection.state = ConnectionState.Closed
      connectionIsRemoved = true
      removeConnection(srcType, id)
    }

    // Run disconnection handlers
    if (connectionIsRemoved) {
      const handlers = disconnectionHandlers.get(srcType)
      if (handlers) handlers.forEach(cb => cb(connection.id))
    }
  }
  port.onDisconnect.addListener(disconnectListener)

  // Send connection confirmation message
  const conConfirmId = _localType === InstanceType.bg ? -1 : -2
  port.postMessage(conConfirmId)
}

const connectionHandlers: Map<InstanceType, ((id: ID) => void)[]> = new Map()
export function onConnected(type: InstanceType, cb: (winOrTabId: ID) => void) {
  if (type === InstanceType.bg && state.bgConnection) cb(NOID)
  if (type === InstanceType.sidebar) state.sidebarConnections.forEach(con => cb(con.id))
  if (type === InstanceType.setup) state.setupPageConnections.forEach(con => cb(con.id))
  if (type === InstanceType.search) state.searchPopupConnections.forEach(con => cb(con.id))
  if (type === InstanceType.editing) state.editingPopupConnections.forEach(con => cb(con.id))
  if (type === InstanceType.sync) state.syncConnections.forEach(con => cb(con.id))
  if (type === InstanceType.panelConfig) state.panelConfigConnections.forEach(con => cb(con.id))
  if (type === InstanceType.group) state.groupPageConnections.forEach(con => cb(con.id))
  if (type === InstanceType.preview && state.previewConnection) cb(NOID)

  const handlers = connectionHandlers.get(type) ?? []
  handlers.push(cb)
  connectionHandlers.set(type, handlers)
}

interface ConnectionAwaiter {
  type: InstanceType
  id: ID
  ok: () => any
  timer?: number
}
const waitingForConnection: ConnectionAwaiter[] = []
export async function waitForConnection(t: InstanceType, winOrTabId: ID, timeout: number) {
  return new Promise<void>((ok, meh) => {
    const w: ConnectionAwaiter = { type: t, id: winOrTabId, ok }
    w.timer = setTimeout(() => {
      rmFromArray(waitingForConnection, w)
      meh(`IPC.waitForConnection: ${Info.getInstanceName(t)}: ${winOrTabId}: timeout`)
    }, timeout)
    waitingForConnection.push(w)
  })
}
function triggerConnectionAwaiters(t: InstanceType, winOrTabId: ID) {
  const w = waitingForConnection.find(w => w.type === t && w.id === winOrTabId)
  if (!w) return
  clearTimeout(w.timer)
  rmFromArray(waitingForConnection, w)
  w.ok()
}

const disconnectionHandlers: Map<InstanceType, ((id: ID) => void)[]> = new Map()
export function onDisconnected(type: InstanceType, cb: (winOrTabId: ID) => void) {
  const handlers = disconnectionHandlers.get(type) ?? []
  handlers.push(cb)
  disconnectionHandlers.set(type, handlers)
}

/**
 * Runs a registered action (service function)
 * and returns its result.
 */
export function runActionFor<T extends InstanceType, A extends keyof Actions>(
  msg: Message<T, A>
): any {
  if (msg.action !== undefined && actions) {
    const action = actions[msg.action] as AnyFunc
    if (action) {
      if (msg.arg !== undefined) return action(msg.arg)
      else if (msg.args) return action(...msg.args)
      else return action()
    }
  }
}

const runningAsyncActions = new Map<string, browser.runtime.Port>()
/**
 * Handles message received from Port in background instance
 * and sends the answer message with the action result.
 */
async function onPostMsg<T extends InstanceType, A extends keyof Actions>(
  msg: Message<T, A> | number,
  port?: browser.runtime.Port,
  connection?: ConnectionInfo
): Promise<void> {
  // Handle confirmation of connection.
  // -1/-2 are connection-confirmation sentinels; the waiter lives on the
  // connection whose localPort delivered this message (closure-provided), so
  // concurrent connections never resolve each other. Other negatives (e.g. the
  // -99 liveness probe) are intentionally ignored here.
  if ((msg as number) < 0) {
    if ((msg === -1 || msg === -2) && connection?.conConfirmResolve) {
      if (connection.conConfirmTimeout !== undefined) clearTimeout(connection.conConfirmTimeout)
      const resolve = connection.conConfirmResolve
      connection.conConfirmTimeout = undefined
      connection.conConfirmResolve = undefined
      resolve()
    }
    return
  }

  // Handle simple confirmation of a received message
  if (typeof msg === 'number') {
    const waiting = msgsWaitingForAnswer.get(msg)
    if (waiting) clearTimeout(waiting.timeout)
    return
  }

  // Handle answer
  if (!msg.action && msg.id) {
    const waiting = msgsWaitingForAnswer.get(msg.id)
    if (waiting) {
      clearTimeout(waiting.timeout)
      if (msg.error && waiting.err) waiting.err(msg.error)
      else if (waiting.ok) waiting.ok(msg.result)
      msgsWaitingForAnswer.delete(msg.id)
    }
    return
  }

  // Dedupe re-delivered messages so non-idempotent actions never run twice.
  // Only applies to answer-expecting action messages that carry a stable uid.
  if (msg.uid !== undefined && msg.action && msg.id && port) {
    const existing = processedMsgs.get(msg.uid)
    if (existing) {
      if (existing.done) {
        // Already finished: answer this re-delivery with the cached result.
        try {
          port.postMessage({ id: msg.id, result: existing.result, error: existing.error })
        } catch (err) {
          Logs.err(`IPC.onPostMsg: Error re-sending cached result:`, err)
        }
      } else {
        // Still running: queue this delivery's answer and confirm receipt so
        // the initiator stops retrying; the original run will answer it.
        existing.pendingAnswers.push({ id: msg.id, port })
        try {
          port.postMessage(msg.id)
        } catch {
          /* port may be dead */
        }
      }
      return
    }
    // First delivery of this uid — mark in-flight before running the action.
    processedMsgs.set(msg.uid, { done: false, pendingAnswers: [] })
  }

  // Run an action
  let result, error
  try {
    result = runActionFor(msg)
  } catch (err) {
    error = String(err)
    Logs.err(`IPC.onPostMsg: Error on running "${String(msg.action)}" action:`, err)
  }

  // Send the result
  if (msg.id && port) {
    if (result instanceof Promise) {
      const msgId = msg.id

      // Send confirmation message
      try {
        port.postMessage(msgId)
      } catch (err) {
        Logs.err(`IPC.onPostMsg: Error on sending "${String(msg.action)}" action confirm:`, err)
        return
      }

      // ...then wait for the final result and send it too
      let finalResult, error
      const asyncActionId = msgId + port.name
      try {
        runningAsyncActions.set(asyncActionId, port)
        finalResult = await result
      } catch (err) {
        error = String(err)
      }

      // Cache the result for dedup (also answers any duplicate deliveries that
      // queued while the action was running).
      finalizeProcessedMsg(msg.uid, finalResult, error)

      // Check if result is not needed anymore
      if (!runningAsyncActions.has(asyncActionId)) return
      else runningAsyncActions.delete(asyncActionId)

      try {
        port.postMessage({ id: msgId, result: finalResult, error })
      } catch (err) {
        Logs.err(`IPC.onPostMsg: Error on sending "${String(msg.action)}" action result:`, err)
        return
      }
    } else {
      finalizeProcessedMsg(msg.uid, result, error)
      try {
        port.postMessage({ id: msg.id, result, error })
      } catch (err) {
        Logs.err(`IPC.onPostMsg: Error on sending "${String(msg.action)}" action result:`, err)
      }
    }
  }
}

/**
 * Handles the message broadcasted with runtime.sendMessage,
 * checks destination
 * and sends result back.
 */
function onSendMsg<T extends InstanceType, A extends keyof Actions>(msg: Message<T, A>) {
  // Check if this instance is the correct destination
  if (msg.dstWinId !== undefined && msg.dstWinId !== _localWinId) return
  if (msg.dstType !== undefined && msg.dstType !== _localType) return
  // A message targeted at a specific tab must not be handled by other tabs of
  // the same instance type (runtime.sendMessage is delivered to all contexts).
  if (msg.dstTabId !== undefined && msg.dstTabId !== _localTabId) return

  // Run an action
  let result
  try {
    result = runActionFor(msg)
  } catch (err) {
    Logs.err(`IPC.onSendMsg: Error on running "${String(msg.action)}" action:`, err)
  }

  // Send the result
  if (result instanceof Promise) return result
  else if (result !== undefined) return Promise.resolve(result)
}

export function setupConnectionListener(): void {
  Logs.info('IPC.setupConnectionListener()')
  browser.runtime.onConnect.addListener(onConnect)
}

export function setupGlobalMessageListener(): void {
  browser.runtime.onMessage.addListener(onSendMsg)
}

function resolveUnfinishedCommunications(port: browser.runtime.Port) {
  Logs.info('IPC.resolveUnfinishedCommunications()')

  // For initiator of the request
  for (const [msgId, waiting] of msgsWaitingForAnswer) {
    if (waiting.port === port) {
      clearTimeout(waiting.timeout)
      if (waiting.err) waiting.err('IPC: Target disconnected: ' + port.name)
      msgsWaitingForAnswer.delete(msgId)
    }
  }

  // For the request handler
  for (const [msgId, actionPort] of runningAsyncActions) {
    if (actionPort === port) {
      runningAsyncActions.delete(msgId)
    }
  }
}

export function disconnectFrom(fromType: InstanceType, winOrTabId?: ID) {
  if (winOrTabId === undefined) winOrTabId = NOID

  // Check connection data
  if (fromType !== InstanceType.bg && fromType !== InstanceType.preview && winOrTabId === NOID) {
    return Logs.err('IPC.disconnectFrom: No winOrTabId')
  }

  const connection = getConnection(fromType, winOrTabId)
  if (!connection) return
  if (connection.localPort) {
    resolveUnfinishedCommunications(connection.localPort)
    connection.localPort.disconnect()
    connection.localPort.onMessage.removeListener(connection.postListener)
    connection.localPort.onDisconnect.removeListener(connection.disconnectListener)
    connection.localPort = undefined
  }
  if (connection.remotePort) {
    resolveUnfinishedCommunications(connection.remotePort)
    connection.remotePort.disconnect()
    connection.remotePort.onMessage.removeListener(connection.postListener)
    connection.remotePort.onDisconnect.removeListener(connection.disconnectListener)
    connection.remotePort = undefined
  }

  clearTimeout(connection.reconnectingTimeout)

  // Remove connection
  let connectionIsRemoved = false
  if (!connection.remotePort && !connection.localPort) {
    connectionIsRemoved = true
    removeConnection(fromType, winOrTabId)
  }

  // Run disconnection handlers
  if (connectionIsRemoved) {
    const handlers = disconnectionHandlers.get(fromType)
    if (handlers) handlers.forEach(cb => cb(connection.id))
  }
}
