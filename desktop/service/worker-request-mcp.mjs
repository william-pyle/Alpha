import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const keyPattern = '^[A-Za-z0-9_-]{1,64}$';
const uuidPattern = '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$';
const uuid = { type: 'string', pattern: uuidPattern };
const actions = ['close-preview', 'stop-terminal'];
const shape = (properties = {}) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const definitions = {
  alpha_list_disposable_previews: {
    kind: 'targets', description: 'List exact handles for Alpha-owned disposable preview tabs available to this task.', inputSchema: shape(),
  },
  alpha_request: {
    kind: 'request', description: 'Ask Alpha to handle a typed action. Reuse the same request key when checking or retrying the same action. Use a handle from the preview list for close-preview. Terminal stops are unsupported by this bridge.',
    inputSchema: shape({ requestKey: { type: 'string', pattern: keyPattern }, action: { type: 'string', enum: actions }, targetId: uuid }),
  },
  alpha_request_result: {
    kind: 'result', description: 'Read the status and result of an Alpha request using the receipt ID returned to this session.', inputSchema: shape({ receiptId: uuid }),
  },
};

const origin = process.env.ALPHA_WORKER_REQUEST_ORIGIN;
const token = process.env.ALPHA_WORKER_REQUEST_TOKEN;
const endpoint = URL.canParse(origin || '') ? new URL(origin) : null;
const configured = endpoint && endpoint.origin === origin && endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && endpoint.port
  && /^[A-Za-z0-9_-]{43}$/.test(token || '');
const failure = text => ({ isError: true, content: [{ type: 'text', text }] });

function payload(tool, values) {
  const props = tool.inputSchema.properties;
  const names = Object.keys(values);
  if (names.length !== Object.keys(props).length || names.some(name => !Object.hasOwn(props, name))) return null;
  for (const name of names) {
    const value = values[name], field = props[name];
    if (typeof value !== 'string' || (field.pattern && !new RegExp(field.pattern).test(value)) || (field.enum && !field.enum.includes(value))) return null;
  }
  return { kind: tool.kind, ...values };
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

const server = new Server({ name: 'alpha_session_requests', version: '1.0.0' }, { capabilities: { tools: {} } });
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
