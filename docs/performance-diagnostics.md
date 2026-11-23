# Performance Diagnostics

Open **Settings → Performance Diagnostics**, enable collection, choose a
category, and select **Capture next operation**. The first authenticated local
request in that category claims the capture. Choose Conversation input for
coordinator timing, Window hydration for a reload of the window, or Workspace or
files for an explicit project size refresh. A matching automatic refresh can
claim a category that includes background reads.

Arming expires after one minute. A capture stops after six minutes or ten
seconds after the selected operation and held stages finish. This tail can
include a worker receipt or completion that arrives promptly. Stop or disable
collection at any time. The measured operation continues normally.

The opt-in preference persists in Alpha settings. Arming, an active capture and
the latest completed capture live in memory. Closing or crashing Alpha discards
them. Export JSON to keep a copy. Delete capture removes the memory copy.

## Recording

The authenticated loopback service keeps the first quarter of the capture and a
rotating tail, up to 1,024 events total by default, with a dropped count. Active
collection schedules no disk writes. The capture contains a UTC start and
monotonic service offsets. Renderer durations use the renderer clock, with the
associated service timestamp marking receipt. Surface startup, UI and provider
times have different origins.

Per-capture keyed aliases correlate operation, thread, turn, worker, RPC and tool
call IDs. Stop discards the key and the bounded alias cache. Size fields round
up to 256 characters or 4 KiB. The export contains only allowlisted phase
labels, methods, selected tool names, correlation aliases and primitive timing
metadata. Application history is independent from diagnostics.

## Coverage

- **UI and routing.** `src/desktop/client.ts` and `ThreadConversations.tsx`
  record request preparation, response, React commit and supported renderer
  long-task summaries. The isolated Settings fixture verifies request timing
  and JSON export. The compositor and time before request preparation are
  outside these measurements.
- **Queue, context and app-server.** `server.mjs` and `coordinator.mjs`
  record HTTP admission, routing, queue wait, cold and warm startup, context,
  local IPC, frame handling, first text, tools, persistence and broadcasts.
  Controlled tests cover early, late, mismatched and ignored events, silence,
  timeout and interrupt. Same-thread mismatches in the existing handler are
  labeled `accepted-unchecked`. Capture does not change event matching.
- **Provider.** The real CLI was exercised with a loopback Responses fixture
  and with a clean unauthenticated profile. The fixture supplies request and
  first SSE write times. The real profile supplies typed errors and retry
  metadata. Supported metrics-only Codex OTLP in a disposable profile can
  distinguish an HTTP attempt and status, with batched aggregate timings.
  Exact upstream start, first byte and provider inference require a supported
  per-request boundary. Alpha does not configure an exporter. See
  [Codex observability](https://learn.chatgpt.com/docs/config-file/config-advanced#observability-and-telemetry).
- **Worker and PTY.** `sessions.mjs` and `terminal-submission.mjs` record
  launch/exit, binding, queue and readiness, receipt, paste and submit intent
  and writes, and matched native input. Completion records the existing worker
  evidence check. The isolated model-mediated and direct fixtures use a fake
  PTY and provider receipt. A process launch is distinct from native prompt
  readiness.
- **Startup and hydration.** `server.mjs` records service ready timing with
  the selected bootstrap, and `client.ts` reports the first scheduled frame.
  The packaged runtime fixture exercises bootstrap. Pre-service Windows
  startup and installer activity occur before this service can arm.
- **Workspace and storage.** HTTP boundaries cover file and registry requests.
  `project-storage.mjs` adds explicit scan queue, start and finish, including
  the native bridge round trip. The browser and storage fixtures exercise
  these paths. Kernel I/O is outside the measurement.
- **Voice and dictation.** `dictation.mjs` records upload size bucket,
  admission, duplicate detection, local or remote pipeline time and HTTP
  response status. `server.mjs` also brackets Live session negotiation.
  Dictation fixtures exercise the pipeline. Physical microphone onset,
  streaming WebRTC latency and speaker output are unverified.
- **Updates and integrations.** `updates.mjs` records remote response and
  staged download boundaries. Service spans cover Settings, checks and
  bindings, with MCP check start and return. Existing update and MCP fixtures
  exercise these flows. Connector internals and activity outside the selected
  capture are outside the recorded scope.
- **Pressure and recovery.** Active sampling records service event-loop drift,
  CPU, RSS and event-loop utilization. Coordinator and worker boundaries
  expose queue depth, IPC backpressure, terminal WebSocket backpressure and
  timeout/retry/cancel observations where available. Isolated captures verify
  pressure sampling. The samples cannot identify an upstream provider queue.

Focused checks are in `desktop/service/test/performance-diagnostics.test.mjs`
and `desktop/service/test/performance-diagnostics-ui.mjs`. Use a fresh
synthetic request for each diagnostic. Existing operation ledgers retain
their original timing boundaries.
