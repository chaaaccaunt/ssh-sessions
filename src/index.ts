export type {
  AuthStrategy,
  ConnectionRequest,
  ConnectionRequestInput,
  ConnectionTarget,
  HostKeyPolicy,
  KeyAuthStrategy,
  PasswordAuthStrategy,
  SecretProvider,
  SshConfigAuthStrategy
} from "./domain/connection"
export { validateConnectionRequest } from "./domain/connectionValidation"
export type { ProcessResult, ProcessStatus } from "./domain/processResult"
export {
  classifyOpenSshFailure,
  sanitizeOpenSshDiagnostic
} from "./domain/openSshFailure"
export type { OpenSshOperation } from "./domain/openSshFailure"
export { classifyHostKeyFailure, toHostKeyError } from "./domain/hostKey"
export type { HostKeyFailureKind } from "./domain/hostKey"
export { SSH_ERROR_CODES, SshError } from "./domain/sshError"
export type { SshErrorCode, SshErrorOptions } from "./domain/sshError"
export type {
  ConnectOptions,
  DownloadRequest,
  ExecuteOutput,
  ExecuteRequest,
  ExecuteStdin,
  FileTransferResult,
  SftpBatchOperation,
  SftpBatchRequest,
  SessionOperationOptions,
  SessionEvent,
  SessionEventHandler,
  SessionState,
  SshSessionApplication,
  UploadRequest
} from "./application/SshSessionApplication"
export { OpenSshSessionService } from "./application/OpenSshSessionService"
export { DoctorService } from "./application/doctor/DoctorService"
export type { DoctorReport, DoctorToolResult } from "./application/doctor/DoctorService"
export { OpenSshTargetResolver, parseSshConfigOutput } from "./application/targets/OpenSshTargetResolver"
export type { ResolvedSshTarget } from "./application/targets/OpenSshTargetResolver"
export {
  buildKnownHostFindCommand,
  buildKnownHostRemovalCommand,
  formatKnownHostQuery,
  HostKeyTrustService
} from "./application/hostKeys/HostKeyTrustService"
export type {
  HostKeyDiagnostic,
  KnownHostCommand,
  KnownHostLookup
} from "./application/hostKeys/HostKeyTrustService"
export {
  classifyAskpassPrompt,
  OpenSshAskpassBroker,
  runWithAskpass
} from "./infrastructure/askpass/AskpassBroker"
export type {
  AskpassBrokerOptions,
  AskpassPromptKind,
  AskpassSession,
  HostKeyConfirmationRequest
} from "./infrastructure/askpass/AskpassBroker"
export {
  buildScpDownloadArguments,
  buildScpUploadArguments,
  buildSftpArguments,
  buildSshConfigQueryArguments,
  buildSshConnectArguments,
  buildSshExecuteArguments
} from "./infrastructure/openssh/OpenSshArguments"
export { buildSftpBatch } from "./infrastructure/openssh/SftpBatch"
export type {
  OpenSshBuildContext,
  ScpTransferOptions,
  SftpArgumentsOptions,
  SshExecuteOptions
} from "./infrastructure/openssh/OpenSshArguments"
export { NodeProcessRunner } from "./infrastructure/process/NodeProcessRunner"
export type {
  ProcessRunner,
  ProcessOutputHandler,
  ProcessStdioMode,
  RunProcessRequest
} from "./infrastructure/process/ProcessRunner"
export { redactDiagnosticValue } from "./security/redaction"
