# Chat History v2

Chat History v2 replaces the legacy `localStorage`-only ring (20 threads, 200
messages each) with a versioned, workflow-aware history system.

## Conversation scope

Settings → ComfyUI MCP Agent → General → **Chat conversation scope**:

- **Panel** keeps one conversation while canvases change.
- **Workflow** keeps an independent collection of conversations for every graph.
- **Ask** chooses between those behaviors whenever the active workflow changes.

The plus button starts a new conversation without deleting older chats. The
history button opens search, current-workflow filtering, rename, pin, delete,
export, and merge-import controls.

## Identity

Bridge routing still uses `wf:<path>`/`tmp:<uuid>` because the orchestrator binds
agents to the current tab. Transcript identity is separate:
`workflow:<embedded UUID>`. The UUID is stored in
`workflow.extra.comfyui_mcp.workflow_uuid` on the first per-workflow chat.

Renaming therefore preserves history. Opening a copied graph as another workflow
detects the repeated UUID and gives the copy a fresh identity. A path→UUID alias
map provides backward compatibility before the graph is next saved.

## Storage and migration

The canonical browser snapshot is in IndexedDB database
`comfyui-mcp-panel-history`, schema version 2. A small `localStorage` shadow is
kept for instant paint and compatibility with older panel builds. On startup the
panel merges legacy and IndexedDB snapshots by thread ID and timestamp, then
writes the migrated schema back automatically.

## Continuity and graph versions

Each thread records its provider, model, effort, session ID, active workflow,
and timestamps. Each user turn points to an FNV-1a graph hash plus node count;
graphs up to 300 KB also keep the serialized workflow snapshot. The hash is shown
inside the user bubble and in the history list.

When a provider session ID is absent, the panel creates a fresh session and arms
a bounded transcript replay for the next message. Existing session IDs continue
through the orchestrator's resume path (including its stale-session recovery).

## Limits

IndexedDB keeps up to 500 threads with 5,000 recorded entries per thread. The
small compatibility shadow remains 20×200. JSON imports merge by ID and keep the
newest revision; import never deletes current history.
