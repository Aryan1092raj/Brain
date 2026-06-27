# Brain

> Local-first always-on daemon for codebase intelligence with memory decay, temporal tracking, and knowledge graph capabilities.

Brain is a persistent codebase memory system. It indexes your repository structure, builds a property graph of files and code symbols (functions, classes, imports, contains, calls), tracks stability with memory decay scores, detects anomaly hot zones, predicts co-changes, and generates instant LLM-friendly prompt digests.

---

## 🚀 Quick Start & Installation

### Local Global Installation (For Testing on Other Projects)

To install the `brain` CLI command globally on your machine to test it on another codebase:

```bash
# 1. Clone this repository and install dependencies
git clone https://github.com/your-username/brain.git
cd brain
npm install

# 2. Build the project
npm run build

# 3. Link the package globally
npm link
# or: npm install -g .
```

Now you can use the `brain` CLI command from any folder on your machine!

```bash
# 4. Go to any other project repository
cd /path/to/your/other-project

# 5. Initialize the Brain configuration and databases
brain init

# 6. Scan and index the codebase once
brain scan

# 7. Start the daemon (runs the background decay scheduler and web dashboard)
brain watch
```

Open `http://localhost:3747` in your browser to view the interactive dashboard for your project!

---

## 🔗 GitIngest-Style Ingestion (Web / URL routing)

Brain supports GitIngest-style URL routing. If you run Brain as a web service or run it locally, you can instantly ingest any GitHub repository by typing its URL structure directly into the address bar:

- **Original GitHub URL**: `https://github.com/facebook/react`
- **Brain Ingestion URL**: `http://localhost:3747/github.com/facebook/react`
- **Shortcut URL**: `http://localhost:3747/facebook/react`

Visiting this URL will automatically download, extract, parse, and ingest the repository into the property graph, rendering the file tree, LLM prompt digest viewer, and dashboard navigation.

---

## 🌟 Key Features

- **🧠 Interactive Knowledge Graph** — D3.js force-directed graph of files, symbols, commits, and relationships.
- **⏳ Memory Decay Simulator** — Ebbinghaus-inspired memory decay scoring with interactive timeline scrubbing in the browser.
- **🔥 Hot Zone Tracking** — Z-score change velocity anomaly detection for rapidly modified code.
- **🌊 Ripple Path Blast Radius** — Traverse downstream calls to trace the blast radius of changes.
- **🔮 Co-Change Prediction** — SQLite-backed engine that calculates commit co-occurrences to predict related modifications.
- **🤖 AGENTS.md Generator** — Auto-generated codebase temporal status files for Cursor, Windsurf, or Claude coding assistants.
- **🔌 Model Context Protocol (MCP)** — Emits symbols and decay status directly to LLM editors on stdio.

---

## 🛠️ Requirements

- **Node.js** >= 22
- **npm**
- **Git**
- **LLM API Key** (Groq API Key is recommended for fast and cost-effective node summaries. Get a free key at [console.groq.com](https://console.groq.com)).

---

## ⚙️ Configuration

Configure your environment by copying `.env.example` to `.env`:

```bash
GROQ_API_KEY=your_groq_api_key_here
GITHUB_TOKEN=your_github_pat_here  # Optional: For private or high-rate-limit remote repository downloads
BRAIN_PORT=3747
```

You can customize tracked repositories by editing `brain.config.json` created by `brain init`:

```json
{
  "repos": [
    {
      "name": "my-app",
      "path": "/absolute/path/to/my-app",
      "remote": "https://github.com/username/my-app",
      "languages": ["typescript", "javascript", "python"],
      "branch": "main"
    }
  ],
  "port": 3747,
  "logLevel": "info"
}
```

---

## 💻 CLI Commands Reference

| Command | Description |
|:---|:---|
| `brain init` | Initialize Brain database and configurations in the current directory |
| `brain scan` | Index the configured repository properties once |
| `brain watch` | Start the daemon server (web dashboard, webhook ingest, scheduler) |
| `brain status` | Output tracked file/symbol counts, hot zones, and memory stats |
| `brain query "<question>"` | Ask a natural language question against the Cypher graph |
| `brain ask "<question>"` | Query Groq with context-enhanced graph facts |
| `brain mcp` | Starts the Model Context Protocol stdio server |

---

## 🧪 Development & Testing

Run the test suite:

```bash
# Compile TypeScript files
npm run build

# Run unit tests inside isolated child processes (prevents Kuzu database locks/segfaults)
npm test
```

---

## 📄 License

MIT
