# TriliumNext MCP Server

A Model Context Protocol (MCP) server for interacting with [TriliumNext](https://github.com/TriliumNext/Notes) via its ETAPI.

## Features

- 27 focused tools for note management, search, organization, attachments, and system operations
- Support for both STDIO and HTTP transports
- Flexible configuration via CLI, environment variables, or config file
- TypeScript with full type safety

## Installation

Please be sure to note the folder that you clone the repository into below.
```bash
git clone https://github.com/perfectra1n/triliumnext-mcp
cd triliumnext-mcp
npm install
npm run build
```

Then as an example, for adding it to Claude Code:
```bash
claude mcp add trilium node <path_to_repository>/triliumnext-mcp/dist/index.js --scope user -e TRILIUM_TOKEN=<your_etapi_token_from_trilium> -e TRILIUM_URL=<your_full_trilium_url_e.g._https://trilium.example.com>
```

The above command will add it to your `.mcpServers` block in your `~/.claude.json` file, at the user scope (so you can use it across any repository).

## Configuration

Configuration precedence (highest to lowest):
1. CLI arguments
2. Environment variables
3. Configuration file (`./trilium-mcp.json` or `~/.trilium-mcp.json`)
4. Default values

### CLI Arguments

```bash
cd triliumnext-mcp
npm install -g .
triliumnext-mcp --url http://localhost:37740/etapi --token YOUR_TOKEN
```

Options:
- `-u, --url <url>` - Trilium ETAPI URL (default: `http://localhost:37740/etapi`)
- `-t, --token <token>` - Trilium ETAPI token (required)
- `--transport <type>` - Transport type: `stdio` or `http` (default: `stdio`)
- `-p, --port <port>` - HTTP server port when using http transport (default: `3000`)
- `-h, --help` - Show help message

### Environment Variables

```bash
export TRILIUM_URL=http://localhost:37740/etapi
export TRILIUM_TOKEN=your-etapi-token
export TRILIUM_TRANSPORT=stdio
export TRILIUM_HTTP_PORT=3000
```

### Config File

Create `trilium-mcp.json` in the current directory or `~/.trilium-mcp.json`:

```json
{
  "url": "http://localhost:37740/etapi",
  "token": "your-etapi-token",
  "transport": "stdio",
  "httpPort": 3000
}
```

## Usage with Claude Code

Add the server to your Claude Code configuration:

```bash
claude mcp add triliumnext-mcp -- node /path/to/triliumnext-mcp/dist/index.js --token YOUR_TOKEN
```

Or configure it in your Claude Code settings.

## Available Tools

### Notes - Core Operations (6 tools)

| Tool | Description |
|------|-------------|
| `create_note` | Create a new note with title, content, type, and parent |
| `get_note` | Get note metadata by ID |
| `get_note_content` | Get the content/body of a note |
| `update_note` | Update note title, type, or MIME type |
| `update_note_content` | Update the content/body of a note |
| `delete_note` | Delete a note by ID |

### Search & Discovery (2 tools)

| Tool | Description |
|------|-------------|
| `search_notes` | Full-text and attribute search with filters |
| `get_note_tree` | Get children of a note (for navigation) |

### Organization (4 tools)

| Tool | Description |
|------|-------------|
| `move_note` | Move a note to a different parent |
| `clone_note` | Clone a note to appear in multiple locations |
| `reorder_notes` | Change note positions within a parent |
| `delete_branch` | Delete a branch without deleting the note |

### Attributes & Labels (4 tools)

| Tool | Description |
|------|-------------|
| `get_attributes` | Get all attributes (labels/relations) of a note |
| `get_attribute` | Get a single attribute by its ID |
| `set_attribute` | Add or update an attribute on a note |
| `delete_attribute` | Remove an attribute from a note |

### Calendar & Journal (2 tools)

| Tool | Description |
|------|-------------|
| `get_day_note` | Get or create the daily note for a date |
| `get_inbox_note` | Get the inbox note for quick capture |

### System & Backup (3 tools)

| Tool | Description |
|------|-------------|
| `create_revision` | Create a revision (snapshot) of a note |
| `create_backup` | Create a full database backup |
| `export_note` | Export a note and its subtree as a ZIP file |

### Attachments (6 tools)

| Tool | Description |
|------|-------------|
| `create_attachment` | Create a new attachment for a note |
| `get_attachment` | Get attachment metadata by ID |
| `update_attachment` | Update attachment metadata |
| `delete_attachment` | Delete an attachment by ID |
| `get_attachment_content` | Get the content/body of an attachment |
| `update_attachment_content` | Update the content/body of an attachment |

## Development

### Prerequisites

- Node.js 20+
- npm

### Setup

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Run linter
npm run lint

# Format code
npm run format
```

### Docker

Start Trilium and the MCP server:

```bash
cd docker
TRILIUM_TOKEN=your-token docker compose up -d
```

Build the Docker image:

```bash
docker build -t triliumnext-mcp -f docker/Dockerfile .
```

## Getting an ETAPI Token

1. Open TriliumNext in your browser
2. Go to Options (gear icon) → ETAPI
3. Create a new ETAPI token
4. Copy the token and use it in your configuration

## License

MIT
