import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const keyPattern = '^[A-Za-z0-9_-]{1,64}$';
const uuidSource = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const uuid = { type: 'string', pattern: '^' + uuidSource.replaceAll('a-f', 'a-fA-F') + '$' };
const plainTextExcluded = '\\u0000-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069';
const requestKey = { type: 'string', pattern: keyPattern };
const projectId = { type: 'string', minLength: 1, maxLength: 100, pattern: '^(?!\\.{1,2}$)(?!\\s)(?!.*\\s$)[^/\\\\:?#' + plainTextExcluded + ']+$' };
const tabId = { type: 'string', pattern: '^(?:step-(?:0|[1-9][0-9]{0,5})|legacy-[a-f0-9]{64}|' + uuidSource + ')$' };
const canonicalProjectId = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,99}$' };
const revision = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const text = maxLength => ({ type: 'string', minLength: 1, maxLength, pattern: '^(?=.*\\S)[^' + plainTextExcluded + ']+$' });
const choice = (...values) => ({ type: 'string', enum: values });
const boolean = { type: 'boolean' };
const shape = (properties = {}, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const projectPatch = {
  ...shape({
    status: choice('active', 'done', 'archived'),
    category: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' },
    pinned: boolean,
  }, []),
  minProperties: 1,
};
const expanded = (action, description, fields = {}, needsTarget = false) => ({
  kind: 'request', action, description,
  inputSchema: shape({ requestKey, ...(needsTarget ? { targetId: uuid } : {}), ...fields }),
});
const definitions = {
  alpha_list_disposable_previews: {
    kind: 'targets', description: 'List exact handles for Alpha-owned disposable preview tabs available to this task.', inputSchema: shape(),
  },
  alpha_request: {
    kind: 'request', description: 'Ask Alpha to handle a typed action. Reuse the same request key when checking or retrying the same action. Use a handle from the preview list for close-preview. Terminal stops are unsupported by this bridge.',
    inputSchema: shape({ requestKey, action: choice('close-preview', 'stop-terminal'), targetId: uuid }),
  },
  alpha_request_result: {
    kind: 'result', description: 'Read the status and result of an Alpha request using the receipt ID returned to this session.', inputSchema: shape({ receiptId: uuid }),
  },
  alpha_list_session_actions: {
    kind: 'capabilities', description: 'List the current Alpha actions and stable target identifiers that this managed task is eligible to request. Use this list before requesting a specific tab, project, file or registered script.',
    inputSchema: shape(),
  },
  alpha_create_project: expanded('create-project', 'Create a local Alpha project from a built-in template.', { title: text(200), template: choice('gallery', 'research') }),
  alpha_update_project: expanded('update-project', 'Update supported metadata on an exact Alpha project. Changes outside the home project require owner approval.', { projectId, patch: projectPatch }),
  alpha_create_report_tab: expanded('create-report-tab', 'Create a persistent report tab on an exact Alpha project.', { projectId, title: text(80) }),
  alpha_rename_report_tab: expanded('rename-report-tab', 'Rename an exact persistent report tab.', { projectId, tabId, title: text(80) }),
  alpha_remove_report_tab: expanded('remove-report-tab', 'Request owner approval to remove an exact persistent report tab. This differs from closing an open tab.', { projectId, tabId }),
  alpha_open_tab: expanded('open-tab', 'Open the exact app tab listed by Alpha.', {}, true),
  alpha_activate_tab: expanded('activate-tab', 'Select the exact open app tab listed by Alpha.', {}, true),
  alpha_close_tab: expanded('close-tab', 'Close the exact eligible app tab listed by Alpha. Persistent report registration and running terminals stay in place.', {}, true),
  alpha_set_3d_view: expanded('set-3d-view', 'Show or hide the 3D view using its listed Alpha view target.', { visible: boolean }, true),
  alpha_set_message_panel: expanded('set-message-panel', 'Show or hide the conversation panel using its listed Alpha view target.', { visible: boolean }, true),
  alpha_copy_file: expanded('copy-file', 'Request that an exact eligible file revision be copied into the destination project as a new file.', { destinationProjectId: canonicalProjectId, expectedRevision: revision }, true),
  alpha_modify_file: expanded('modify-file', 'Request adding a missing final newline to an exact eligible file revision.', { expectedRevision: revision, edit: choice('ensure-final-newline') }, true),
  alpha_run_script: expanded('run-script', 'Request an exact registered script and revision for this project. Alpha uses the registered invocation.', {
    scriptId: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' }, expectedRevision: revision,
  }),
  alpha_import_project_artifact: expanded('import-artifact', 'Ask Alpha to review and copy an exact project-local skill, knowledge entry, or reusable agent definition to your own project.', {
    sourceProjectId: canonicalProjectId,
    kind: choice('skill', 'knowledge', 'agent'),
    artifactId: { type: 'string', maxLength: 64, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' },
  }),
};

const origin = process.env.ALPHA_WORKER_REQUEST_ORIGIN;
const token = process.env.ALPHA_WORKER_REQUEST_TOKEN;
const endpoint = URL.canParse(origin || '') ? new URL(origin) : null;
const configured = endpoint && endpoint.origin === origin && endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && endpoint.port
  && /^[A-Za-z0-9_-]{43}$/.test(token || '');
const failure = text => ({ isError: true, content: [{ type: 'text', text }] });

function matches(schema, value) {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const entries = Object.entries(value);
    return entries.length >= (schema.minProperties ?? 0)
      && schema.required.every(name => Object.hasOwn(value, name))
      && entries.every(([name, field]) => Object.hasOwn(schema.properties, name) && matches(schema.properties[name], field));
  }
  if (schema.type === 'boolean') return typeof value === 'boolean';
  return typeof value === 'string'
    && value.length >= (schema.minLength ?? 0)
    && value.length <= (schema.maxLength ?? Infinity)
    && (!schema.pattern || new RegExp(schema.pattern, 'u').test(value))
    && (!schema.enum || schema.enum.includes(value));
}

function payload(tool, values) {
  if (!matches(tool.inputSchema, values)) return null;
  if (!tool.action) return { kind: tool.kind, ...values };
  const { requestKey, targetId, ...args } = values;
  return { kind: tool.kind, action: tool.action, requestKey, ...(targetId ? { targetId } : {}),
    ...(Object.keys(args).length ? { arguments: args } : {}) };
}

async function readResponse(response) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 16 * 1024) throw new Error('Oversized bridge response');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid bridge response');
  return value;
}

const server = new Server({ name: 'alpha_session_requests', version: '1.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(definitions).map(([name, { description, inputSchema }]) => ({ name, description, inputSchema })),
}));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: values = {} } = request.params;
  const body = Object.hasOwn(definitions, name) && payload(definitions[name], values);
  if (!body) return failure('Choose a supported Alpha action and supply only its typed arguments.');
  if (!configured) return failure('This session has no active Alpha request bridge.');
  try {
    const response = await fetch(new URL('/worker-request', endpoint), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await readResponse(response);
    if (!response.ok) {
      return failure(typeof result.error === 'string' && result.error.length <= 300 ? result.error : 'Alpha denied or could not handle this request.');
    }
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch {
    return failure('The Alpha request bridge did not respond. If retrying an action, reuse its original request key.');
  }
});

await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 16 * 1024 }));
