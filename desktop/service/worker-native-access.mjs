// Native requests travel over Alpha's existing private desktop pipe. Only
// this fixed set of reasons can affect a worker receipt or recovery decision.
const nativeReasons = new Set(['os-permission', 'policy', 'host-unavailable', 'unknown-outcome', 'recoverable-host']);
const osAccessCodes = new Set(['EACCES', 'EPERM', 'EROFS', 'ERR_ACCESS_DENIED']);

export function accessFailure(status, message, workerAccess, workerReason) {
  return Object.assign(new Error(message), {
    status, workerAccess,
    ...(workerReason && { workerReason }),
    ...(workerAccess === 'recoverable-host' && { noEffect: true }),
  });
}

export function isOsAccessError(error) {
  return osAccessCodes.has(error?.code);
}

export function nativeFailure(status, message, { access, readOnly, workerReason } = {}) {
  let workerAccess = nativeReasons.has(access) ? access : undefined;
  // A possibly dispatched mutation never becomes a retryable host error.
  if (workerAccess === 'recoverable-host' && !readOnly) workerAccess = 'unknown-outcome';
  if (!workerAccess && status === 503) workerAccess = readOnly ? 'host-unavailable' : 'unknown-outcome';
  return accessFailure(status, message, workerAccess, workerReason);
}

export function nativeWaitFailure(message, readOnly, recoverable = false) {
  const reason = readOnly ? recoverable ? 'recoverable-host' : 'host-unavailable' : 'unknown-outcome';
  return accessFailure(503, message, reason);
}
