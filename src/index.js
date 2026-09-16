#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const process = require("process");

// MCP stdio transport is newline-delimited JSON-RPC (one message per line). Content-Length framing (LSP style) is
// accepted too, for clients that still send it; every reply uses the framing of the request that produced it.
let outputFraming = "ndjson";
function serializeMessage(message) {
  const payload = JSON.stringify(message);
  if (outputFraming === "header") {
    return `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
  }
  return `${payload}\n`;
}

class DualFramedReader {
  constructor(onMessage, onError) {
    this.onMessage = onMessage;
    this.onError = onError;
    this.buffer = Buffer.alloc(0);
  }

  append(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.process();
  }

  process() {
    while (true) {
      // skip leading whitespace / blank lines
      let start = 0;
      while (start < this.buffer.length && (this.buffer[start] === 0x0a || this.buffer[start] === 0x0d || this.buffer[start] === 0x20 || this.buffer[start] === 0x09)) start++;
      if (start) this.buffer = this.buffer.subarray(start);
      if (!this.buffer.length) return;

      if (this.buffer[0] === 0x7b /* { */) {
        const nl = this.buffer.indexOf("\n");
        if (nl === -1) return;
        const line = this.buffer.subarray(0, nl).toString("utf8").trim();
        this.buffer = this.buffer.subarray(nl + 1);
        outputFraming = "ndjson";
        this.dispatch(line);
        continue;
      }

      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const headerText = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.onError(new Error(`Missing Content-Length header: ${headerText}`));
        return;
      }
      const contentLength = Number(match[1]);
      const totalLength = headerEnd + 4 + contentLength;
      if (this.buffer.length < totalLength) return;
      const body = this.buffer.subarray(headerEnd + 4, totalLength).toString("utf8");
      this.buffer = this.buffer.subarray(totalLength);
      outputFraming = "header";
      this.dispatch(body);
    }
  }

  dispatch(text) {
    if (!text) return;
    try {
      this.onMessage(JSON.parse(text));
    } catch (error) {
      this.onError(error);
    }
  }
}

function logError(error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
}

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) {
    throw new Error("Missing DEPENDENCY_TRACK_BASE_URL environment variable.");
  }

  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}

function buildApiUrl(baseUrl, endpoint, query) {
  const url = new URL(`${baseUrl}/api${endpoint}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function getAuthHeaders() {
  const apiKey = process.env.DEPENDENCY_TRACK_API_KEY;
  const bearerToken = process.env.DEPENDENCY_TRACK_BEARER_TOKEN;

  if (!apiKey && !bearerToken) {
    throw new Error("Missing DEPENDENCY_TRACK_API_KEY or DEPENDENCY_TRACK_BEARER_TOKEN.");
  }

  const headers = {
    Accept: "application/json",
    "User-Agent": "dependency-track-mcp-server/0.1.0"
  };

  if (apiKey) {
    headers["X-Api-Key"] = apiKey;
  }

  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }

  return headers;
}

async function dependencyTrackRequest({ method = "GET", endpoint, query, json, headers }) {
  const baseUrl = normalizeBaseUrl(process.env.DEPENDENCY_TRACK_BASE_URL);
  const url = buildApiUrl(baseUrl, endpoint, query);
  const requestHeaders = {
    ...getAuthHeaders(),
    ...headers
  };

  const options = {
    method,
    headers: requestHeaders
  };

  if (json !== undefined) {
    requestHeaders["Content-Type"] = "application/json";
    options.body = JSON.stringify(json);
  }

  const response = await fetch(url, options);
  const text = await response.text();
  let body = text;

  const contentType = response.headers.get("content-type") || "";
  if (text && contentType.includes("application/json")) {
    try {
      body = JSON.parse(text);
    } catch (_) {
      body = text;
    }
  }

  if (!response.ok) {
    const error = new Error(`Dependency-Track request failed with ${response.status} ${response.statusText}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body
  };
}

function ensureString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function ensureBoolean(value, name) {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean.`);
  }
  return value;
}

function ensureStringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${name} must be an array of non-empty strings.`);
  }
  return value.map((item) => item.trim());
}

function ensureInteger(value, name, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer.`);
  }
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return value;
}

function readBomAsBase64(bomPath) {
  const resolved = path.resolve(bomPath);
  const bytes = fs.readFileSync(resolved);
  return bytes.toString("base64");
}

const tools = [
  {
    name: "list_projects",
    description: "List Dependency-Track projects.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Optional project name filter." },
        excludeInactive: { type: "boolean", description: "Exclude inactive projects." },
        onlyRoot: { type: "boolean", description: "Return only root projects." },
        notAssignedToTeamWithUuid: { type: "string", description: "Exclude projects assigned to the given team UUID." },
        offset: { type: "integer", description: "Optional zero-based client-side offset into the returned project list." },
        limit: { type: "integer", description: "Optional client-side limit for the number of returned projects." }
      },
      additionalProperties: false
    }
  },
  {
    name: "search_projects_by_name",
    description: "Search projects by exact or partial name, with optional client-side paging.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Project name or substring to search for." },
        excludeInactive: { type: "boolean", description: "Exclude inactive projects." },
        onlyRoot: { type: "boolean", description: "Return only root projects." },
        limit: { type: "integer", description: "Optional client-side limit for the number of returned projects." },
        offset: { type: "integer", description: "Optional zero-based client-side offset into the filtered result set." }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "get_project",
    description: "Fetch a project by UUID.",
    inputSchema: {
      type: "object",
      properties: {
        uuid: { type: "string", description: "Project UUID." }
      },
      required: ["uuid"],
      additionalProperties: false
    }
  },
  {
    name: "lookup_project",
    description: "Fetch a project by name and version.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name." },
        version: { type: "string", description: "Project version." }
      },
      required: ["name", "version"],
      additionalProperties: false
    }
  },
  {
    name: "get_latest_project",
    description: "Fetch the latest version of a project by name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name." }
      },
      required: ["name"],
      additionalProperties: false
    }
  },
  {
    name: "get_project_findings",
    description: "Fetch findings for a project.",
    inputSchema: {
      type: "object",
      properties: {
        projectUuid: { type: "string", description: "Project UUID." },
        suppressed: { type: "boolean", description: "Include suppressed findings." },
        source: { type: "string", description: "Optional vulnerability source filter." }
      },
      required: ["projectUuid"],
      additionalProperties: false
    }
  },
  {
    name: "trigger_project_analysis",
    description: "Trigger on-demand vulnerability analysis for a project.",
    inputSchema: {
      type: "object",
      properties: {
        projectUuid: { type: "string", description: "Project UUID." }
      },
      required: ["projectUuid"],
      additionalProperties: false
    }
  },
  {
    name: "upload_bom",
    description: "Upload a CycloneDX BOM to an existing or auto-created project.",
    inputSchema: {
      type: "object",
      properties: {
        projectUuid: { type: "string", description: "Existing project UUID." },
        projectName: { type: "string", description: "Project name used when projectUuid is omitted." },
        projectVersion: { type: "string", description: "Project version used when projectUuid is omitted." },
        autoCreate: { type: "boolean", description: "Create the project if it does not exist." },
        isLatest: { type: "boolean", description: "Mark auto-created project version as latest." },
        projectTags: { type: "array", items: { type: "string" }, description: "Optional project tags." },
        bomPath: { type: "string", description: "Path to a BOM file on disk." },
        bomBase64: { type: "string", description: "Base64-encoded BOM content." }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_event_token_status",
    description: "Check whether an async Dependency-Track token is still processing.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Async token UUID." }
      },
      required: ["token"],
      additionalProperties: false
    }
  }
];

async function callTool(name, args) {
  switch (name) {
    case "list_projects": {
      const offset = args.offset === undefined ? 0 : ensureInteger(args.offset, "offset", { min: 0 });
      const limit = args.limit === undefined ? null : ensureInteger(args.limit, "limit", { min: 1 });
      const response = await dependencyTrackRequest({
        endpoint: "/v1/project",
        query: {
          name: args.name,
          excludeInactive: args.excludeInactive,
          onlyRoot: args.onlyRoot,
          notAssignedToTeamWithUuid: args.notAssignedToTeamWithUuid
        }
      });

      const projects = Array.isArray(response.body) ? response.body : [];
      const pagedProjects = limit === null ? projects.slice(offset) : projects.slice(offset, offset + limit);
      return {
        offset,
        limit,
        totalCount: Number(response.headers["x-total-count"] || response.headers["total-count"] || 0),
        returnedCount: pagedProjects.length,
        projects: pagedProjects
      };
    }

    case "search_projects_by_name": {
      const query = ensureString(args.query, "query");
      const offset = args.offset === undefined ? 0 : ensureInteger(args.offset, "offset", { min: 0 });
      const limit = args.limit === undefined ? 25 : ensureInteger(args.limit, "limit", { min: 1 });
      const response = await dependencyTrackRequest({
        endpoint: "/v1/project",
        query: {
          name: query,
          excludeInactive: args.excludeInactive,
          onlyRoot: args.onlyRoot
        }
      });

      const projects = Array.isArray(response.body) ? response.body : [];
      const normalizedQuery = query.toLowerCase();
      const exactMatches = [];
      const partialMatches = [];

      for (const project of projects) {
        const projectName = typeof project.name === "string" ? project.name : "";
        const lowerName = projectName.toLowerCase();
        if (lowerName === normalizedQuery) {
          exactMatches.push(project);
        } else if (lowerName.includes(normalizedQuery)) {
          partialMatches.push(project);
        }
      }

      const matches = exactMatches.concat(partialMatches);
      const pagedProjects = matches.slice(offset, offset + limit);

      return {
        query,
        offset,
        limit,
        totalMatches: matches.length,
        returnedCount: pagedProjects.length,
        projects: pagedProjects
      };
    }

    case "get_project": {
      return (
        await dependencyTrackRequest({
          endpoint: `/v1/project/${encodeURIComponent(ensureString(args.uuid, "uuid"))}`
        })
      ).body;
    }

    case "lookup_project": {
      return (
        await dependencyTrackRequest({
          endpoint: "/v1/project/lookup",
          query: {
            name: ensureString(args.name, "name"),
            version: ensureString(args.version, "version")
          }
        })
      ).body;
    }

    case "get_latest_project": {
      return (
        await dependencyTrackRequest({
          endpoint: `/v1/project/latest/${encodeURIComponent(ensureString(args.name, "name"))}`
        })
      ).body;
    }

    case "get_project_findings": {
      const response = await dependencyTrackRequest({
        endpoint: `/v1/finding/project/${encodeURIComponent(ensureString(args.projectUuid, "projectUuid"))}`,
        query: {
          suppressed: args.suppressed,
          source: args.source
        }
      });
      return {
        totalCount: Number(response.headers["x-total-count"] || response.headers["total-count"] || 0),
        findings: response.body
      };
    }

    case "trigger_project_analysis": {
      return (
        await dependencyTrackRequest({
          method: "POST",
          endpoint: `/v1/finding/project/${encodeURIComponent(ensureString(args.projectUuid, "projectUuid"))}/analyze`
        })
      ).body;
    }

    case "upload_bom": {
      const hasProjectUuid = typeof args.projectUuid === "string" && args.projectUuid.trim();
      const hasProjectIdentity =
        typeof args.projectName === "string" &&
        args.projectName.trim() &&
        typeof args.projectVersion === "string" &&
        args.projectVersion.trim();

      if (!hasProjectUuid && !hasProjectIdentity) {
        throw new Error("upload_bom requires either projectUuid or both projectName and projectVersion.");
      }

      const hasBomPath = typeof args.bomPath === "string" && args.bomPath.trim();
      const hasBomBase64 = typeof args.bomBase64 === "string" && args.bomBase64.trim();

      if (!hasBomPath && !hasBomBase64) {
        throw new Error("upload_bom requires bomPath or bomBase64.");
      }

      if (hasBomPath && hasBomBase64) {
        throw new Error("Provide either bomPath or bomBase64, not both.");
      }

      const payload = {
        bom: hasBomPath ? readBomAsBase64(args.bomPath) : args.bomBase64.trim()
      };

      if (hasProjectUuid) {
        payload.project = ensureString(args.projectUuid, "projectUuid");
      } else {
        payload.projectName = ensureString(args.projectName, "projectName");
        payload.projectVersion = ensureString(args.projectVersion, "projectVersion");
        if (args.autoCreate !== undefined) {
          payload.autoCreate = ensureBoolean(args.autoCreate, "autoCreate");
        }
        if (args.isLatest !== undefined) {
          payload.isLatest = ensureBoolean(args.isLatest, "isLatest");
        }
      }

      if (args.projectTags !== undefined) {
        payload.projectTags = ensureStringArray(args.projectTags, "projectTags").map((name) => ({ name }));
      }

      return (
        await dependencyTrackRequest({
          method: "PUT",
          endpoint: "/v1/bom",
          json: payload
        })
      ).body;
    }

    case "get_event_token_status": {
      return (
        await dependencyTrackRequest({
          endpoint: `/v1/event/token/${encodeURIComponent(ensureString(args.token, "token"))}`
        })
      ).body;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function successResponse(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

function errorResponse(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data
    }
  };
}

function formatToolResult(result) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2)
      }
    ],
    structuredContent: result
  };
}

function formatToolError(error) {
  const body = error && typeof error === "object" ? error.body : undefined;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            message: error instanceof Error ? error.message : String(error),
            status: error && typeof error === "object" ? error.status : undefined,
            body
          },
          null,
          2
        )
      }
    ],
    isError: true
  };
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.jsonrpc !== "2.0") {
    process.stdout.write(serializeMessage(errorResponse(message.id ?? null, -32600, "Invalid JSON-RPC version.")));
    return;
  }

  const { id, method, params } = message;

  try {
    if (method === "initialize") {
      process.stdout.write(
        serializeMessage(
          successResponse(id, {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {}
            },
            serverInfo: {
              name: "dependency-track-mcp-server",
              version: "0.1.0"
            }
          })
        )
      );
      return;
    }

    if (method === "notifications/initialized") {
      return;
    }

    if (method === "tools/list") {
      process.stdout.write(serializeMessage(successResponse(id, { tools })));
      return;
    }

    if (method === "tools/call") {
      const toolName = params && params.name;
      const args = (params && params.arguments) || {};
      try {
        const result = await callTool(toolName, args);
        process.stdout.write(serializeMessage(successResponse(id, formatToolResult(result))));
      } catch (error) {
        process.stdout.write(serializeMessage(successResponse(id, formatToolError(error))));
      }
      return;
    }

    if (method === "ping") {
      process.stdout.write(serializeMessage(successResponse(id, {})));
      return;
    }

    process.stdout.write(serializeMessage(errorResponse(id ?? null, -32601, `Method not found: ${method}`)));
  } catch (error) {
    logError(error);
    process.stdout.write(
      serializeMessage(
        errorResponse(id ?? null, -32603, "Internal error", {
          message: error instanceof Error ? error.message : String(error)
        })
      )
    );
  }
}

const reader = new DualFramedReader(handleMessage, (error) => {
  logError(error);
});

process.stdin.on("data", (chunk) => reader.append(chunk));
process.stdin.on("error", (error) => {
  logError(error);
  process.exit(1);
});
