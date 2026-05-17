/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const { Type } = await import('@mariozechner/pi-ai');

// Shell tool
await ctx.insert('shell', 'type', 'Tool');
await ctx.insert('shell', 'tool_schema', JSON.stringify({
  name: 'shell',
  description: 'Execute a shell command and return stdout. Use for running programs, file operations, etc.',
  input_schema: {
    type: 'object',
    properties: {
      cmd: { type: 'string', description: 'The shell command to execute' }
    },
    required: ['cmd']
  }
}));

// Query tool — lets the agent query the graph
await ctx.insert('graph_query', 'type', 'Tool');
await ctx.insert('graph_query', 'tool_schema', JSON.stringify({
  name: 'graph_query',
  description: 'Query the RDF quad graph. Returns quads matching the given pattern. Omit fields to use them as wildcards.',
  input_schema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Subject filter (optional)' },
      predicate: { type: 'string', description: 'Predicate filter (optional)' },
      object: { type: 'string', description: 'Object/value filter (optional)' },
      graph: { type: 'string', description: 'Graph filter (optional)' }
    }
  }
}));

// Insert tool — lets the agent insert quads
await ctx.insert('graph_insert', 'type', 'Tool');
await ctx.insert('graph_insert', 'tool_schema', JSON.stringify({
  name: 'graph_insert',
  description: 'Insert a quad into the RDF graph. If the quad already exists, this is a no-op.',
  input_schema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Subject' },
      predicate: { type: 'string', description: 'Predicate' },
      object: { type: 'string', description: 'Object/value' },
      graph: { type: 'string', description: 'Graph (defaults to _)' }
    },
    required: ['subject', 'predicate', 'object']
  }
}));

// Remove tool — lets the agent remove quads
await ctx.insert('graph_remove', 'type', 'Tool');
await ctx.insert('graph_remove', 'tool_schema', JSON.stringify({
  name: 'graph_remove',
  description: 'Remove a quad from the RDF graph. If the quad does not exist, this is a no-op.',
  input_schema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Subject' },
      predicate: { type: 'string', description: 'Predicate' },
      object: { type: 'string', description: 'Object/value' },
      graph: { type: 'string', description: 'Graph (defaults to _)' }
    },
    required: ['subject', 'predicate', 'object']
  }
}));

// Nodes tool — list all function nodes
await ctx.insert('list_nodes', 'type', 'Tool');
await ctx.insert('list_nodes', 'tool_schema', JSON.stringify({
  name: 'list_nodes',
  description: 'List all function nodes registered in the graph. Returns their names.',
  input_schema: {
    type: 'object',
    properties: {}
  }
}));

// Snapshot export tool
await ctx.insert('snapshot:export', 'type', 'Tool');
await ctx.insert('snapshot:export', 'tool_schema', JSON.stringify({
  name: 'snapshot_export',
  description: 'Export all quads from the graph as JSON. Optionally write to a file path.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to write JSON to (optional — if omitted, returns JSON string)' }
    }
  }
}));

// Snapshot import tool
await ctx.insert('snapshot:import', 'type', 'Tool');
await ctx.insert('snapshot:import', 'tool_schema', JSON.stringify({
  name: 'snapshot_import',
  description: 'Import quads from a JSON string or file path into the graph.',
  input_schema: {
    type: 'object',
    properties: {
      data: { type: 'string', description: 'JSON string containing array of quads (optional if path provided)' },
      path: { type: 'string', description: 'File path to read JSON from (optional if data provided)' }
    }
  }
}));

// Snapshot backup tool
await ctx.insert('snapshot:backup', 'type', 'Tool');
await ctx.insert('snapshot:backup', 'tool_schema', JSON.stringify({
  name: 'snapshot_backup',
  description: 'Create a file-level backup of the SQLite database.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Destination file path (optional — defaults to timestamped name)' }
    }
  }
}));

// Vector search tool
await ctx.insert('vector:search', 'type', 'Tool');
await ctx.insert('vector:search', 'tool_schema', JSON.stringify({
  name: 'vector_search',
  description: 'Semantic search over quads using vector embeddings. Provide text or a pre-computed embedding.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to search for (will be embedded automatically)' },
      embedding: { type: 'array', items: { type: 'number' }, description: 'Pre-computed embedding vector (optional if text provided)' },
      k: { type: 'number', description: 'Number of results to return (default: 10)' }
    }
  }
}));

// Describe tool — inspect all quads about a subject
await ctx.insert('graph_describe', 'type', 'Tool');
await ctx.insert('graph_describe', 'tool_schema', JSON.stringify({
  name: 'graph_describe',
  description: 'Describe a subject: return ALL quads about it (all predicates and values). Useful for inspecting what a node IS.',
  input_schema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'The subject to describe (e.g. a node name)' }
    },
    required: ['subject']
  }
}));

// Subjects tool — list all unique subjects
await ctx.insert('graph_subjects', 'type', 'Tool');
await ctx.insert('graph_subjects', 'tool_schema', JSON.stringify({
  name: 'graph_subjects',
  description: 'List all unique subjects in the graph. Optionally filter by type (Function, Tool, Spawned, etc.).',
  input_schema: {
    type: 'object',
    properties: {
      type: { type: 'string', description: 'Filter by type (e.g. Function, Tool, Spawned). Optional.' }
    }
  }
}));

// Deps tool — analyze node dependencies
await ctx.insert('graph_deps', 'type', 'Tool');
await ctx.insert('graph_deps', 'tool_schema', JSON.stringify({
  name: 'graph_deps',
  description: 'Analyze a node\'s dependency graph: what it calls and what calls it. Uses regex to scan ctx.call references in source code.',
  input_schema: {
    type: 'object',
    properties: {
      node: { type: 'string', description: 'The node name to analyze dependencies for' }
    },
    required: ['node']
  }
}));

// Inspect tool — comprehensive node inspection
await ctx.insert('inspect', 'type', 'Tool');
await ctx.insert('inspect', 'tool_schema', JSON.stringify({
  name: 'inspect',
  description: 'Comprehensive inspection of a node: source, type, dependencies, spawn status, tool schema, etc. Combines graph:describe and graph:deps.',
  input_schema: {
    type: 'object',
    properties: {
      node: { type: 'string', description: 'The node name to inspect' }
    },
    required: ['node']
  }
}));

// Version list tool
await ctx.insert('version_list', 'type', 'Tool');
await ctx.insert('version_list', 'tool_schema', JSON.stringify({
  name: 'version_list',
  description: 'List all saved source versions for a node. Returns version history with sequence numbers and timestamps.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The node name to list versions for' }
    },
    required: ['name']
  }
}));

// Version restore tool
await ctx.insert('version_restore', 'type', 'Tool');
await ctx.insert('version_restore', 'tool_schema', JSON.stringify({
  name: 'version_restore',
  description: 'Restore a node\'s source to a specific version by sequence number.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The node name to restore' },
      seq: { type: 'number', description: 'The version sequence number to restore' }
    },
    required: ['name', 'seq']
  }
}));

// Cron tool
await ctx.insert('cron_create', 'type', 'Tool');
await ctx.insert('cron_create', 'tool_schema', JSON.stringify({
  name: 'cron_create',
  description: 'Create a cron job that runs a node on a setInterval. The node is called repeatedly at the specified interval.',
  input_schema: {
    type: 'object',
    properties: {
      node: { type: 'string', description: 'The node name to run periodically' },
      interval: { type: 'number', description: 'Interval in milliseconds (minimum 100ms)' },
      cronArgs: { type: 'object', description: 'Optional arguments to pass to the node on each tick' }
    },
    required: ['node', 'interval']
  }
}));

// Cron stop tool
await ctx.insert('cron_stop', 'type', 'Tool');
await ctx.insert('cron_stop', 'tool_schema', JSON.stringify({
  name: 'cron_stop',
  description: 'Stop a running cron job by its cronId.',
  input_schema: {
    type: 'object',
    properties: {
      cronId: { type: 'string', description: 'The cron job ID (from cron_create or cron_list)' }
    },
    required: ['cronId']
  }
}));

// Cron list tool
await ctx.insert('cron_list', 'type', 'Tool');
await ctx.insert('cron_list', 'tool_schema', JSON.stringify({
  name: 'cron_list',
  description: 'List all cron jobs (active and stopped).',
  input_schema: {
    type: 'object',
    properties: {}
  }
}));

// Metrics report tool
await ctx.insert('metrics_report', 'type', 'Tool');
await ctx.insert('metrics_report', 'tool_schema', JSON.stringify({
  name: 'metrics_report',
  description: 'Show metrics for all nodes: call counts, total duration, average latency, and error counts. Sorted by call count descending.',
  input_schema: {
    type: 'object',
    properties: {
      raw: { type: 'boolean', description: 'If true, return structured data alongside the formatted report' }
    }
  }
}));

function toTypeBox(schema) {
  if (!schema || typeof schema !== 'object') return Type.Object({});
  const opts = schema.description ? { description: schema.description } : {};
  if (schema.type === 'string') return Type.String(opts);
  if (schema.type === 'number') return Type.Number(opts);
  if (schema.type === 'boolean') return Type.Boolean(opts);
  if (schema.type === 'array') return Type.Array(toTypeBox(schema.items || { type: 'string' }), opts);
  if (schema.type === 'object' || schema.properties) {
    const props = {};
    const required = new Set(schema.required || []);
    for (const [key, value] of Object.entries(schema.properties || {})) {
      const propSchema = toTypeBox(value);
      props[key] = required.has(key) ? propSchema : Type.Optional(propSchema);
    }
    return Type.Object(props, { additionalProperties: true, ...opts });
  }
  return Type.Any(opts);
}

// Normalize every tool schema through TypeBox. The stored graph format remains
// plain JSON schema, but it is generated from pi-ai's TypeBox re-export.
for (const tool of await ctx.query({ predicate: 'type', object: 'Tool' })) {
  const schemas = await ctx.query({ subject: tool.subject, predicate: 'tool_schema' });
  for (const q of schemas) {
    const schema = JSON.parse(q.object);
    schema.input_schema = toTypeBox(schema.input_schema || { type: 'object', properties: {} });
    await ctx.remove(q.subject, q.predicate, q.object, q.graph);
    await ctx.insert(q.subject, q.predicate, JSON.stringify(schema), q.graph);
  }
}

console.log('[agent:tools] registered 19 tools');
