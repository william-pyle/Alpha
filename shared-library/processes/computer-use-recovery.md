# Computer Use connection recovery

Read the installed Computer Use skill and its runtime guidance before acting.
Use only the integration's supported JavaScript runtime and APIs. A failed pipe
is evidence of a transport failure, not proof that the CLI cannot use Computer
Use or that the application being tested is broken.

1. Stop input after a pipe, timeout or capture failure. Record the exact error,
   time and last confirmed action. An uncertain input must not be replayed.
2. Follow the installed skill's bounded lightweight retry. For a persistent pipe
   failure, reset the supported JavaScript runtime once, rerun its documented
   initialization, and perform a harmless app/window enumeration before input.
3. If enumeration succeeds, select fresh returned window handles and capture a
   fresh screenshot. Verify the target window and focus before continuing. Never
   reuse stale screenshot IDs, coordinates, accessibility indexes or handles.
4. If recovery fails, stop and report the error and attempted recovery. Save the
   exact native conversation ID and a durable continuation checkpoint. Ask through
   Questions before restarting only the affected CLI session, unless that exact
   restart is already authorized. Preserve other workers and running apps.

Do not manually launch an internal helper, invent its protocol, reset every
session, change security settings or restart the host application as a workaround.
If the desktop is locked or the user stops Computer Use, stop input and follow
the installed skill's handoff requirements.

A successful reset on a healthy connection proves reset compatibility. It does
not establish recovery from an unreproduced failure or its root cause. Distinguish
enumeration, capture, input, observed application behavior and task acceptance in
the evidence. Keep private screenshots and session IDs in project records.
