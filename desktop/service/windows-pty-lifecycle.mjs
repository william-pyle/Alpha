const guardedAgents = new WeakSet();

// node-pty 1.1.0 does not make WindowsPtyAgent.kill idempotent. Deferred
// proc.kill(), the starting-shell fallback and onExit cleanup can converge on
// the same native pseudo-console. A second native close can corrupt the heap.
// Guard the shared boundary so all three paths retain their cleanup behavior.
// Upstream: https://github.com/microsoft/node-pty/issues/983
export function guardWindowsPtyKill(proc, platform = process.platform) {
  if (platform !== 'win32') return proc;
  const agent = proc._agent;
  if (!agent || guardedAgents.has(agent)) return proc;
  const kill = agent.kill.bind(agent);
  let attempted = false;
  agent.kill = (...args) => {
    if (attempted) return;
    // Mark before entering native code, including reentrant callbacks/errors.
    // An uncertain native close must not be retried against the same handle.
    attempted = true;
    return kill(...args);
  };
  guardedAgents.add(agent);
  return proc;
}
