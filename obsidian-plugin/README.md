# Paper2Slides for Obsidian

An Obsidian desktop plugin for running [Paper2Slides](https://github.com/HKUDS/Paper2Slides) from inside your vault and pulling the latest outputs back in.

This plugin does not generate slides on its own. It connects Obsidian to a local `Paper2Slides` checkout, starts the upstream CLI, tracks the run, and imports the newest results into your vault.

![Paper2Slides Obsidian pipeline](assets/pipeline-diagram.svg)

## What you get

- Settings tab inside Obsidian
- Ribbon button for the current file
- Right-click menu on supported documents, including PDFs, Markdown and Word files
- Command palette actions for generate, re-import, setup check, and stop
- Real generation options instead of hardcoded defaults
- Provider overrides for Z.AI, LM Studio, Ollama, and AnythingLLM
- Provider health checks and model loading for local endpoints
- Run logs saved into the imported output folder

## Use it in a minute

1. Get the original `Paper2Slides` repo running on your machine
2. Make sure its Python dependencies, API keys, and `.env` are in place
3. Build this plugin and drop it into `.obsidian/plugins/paper2slides-obsidian/`
4. Open the plugin settings in Obsidian
5. Set:
    - `Python command`, usually `python3`
    - `Paper2Slides repo path`, pointing to your local checkout
    - `API provider`, if you want to override the repo defaults
    - any generation defaults you want
6. Trigger it from one of these places:
    - the ribbon button
    - the command palette
    - the right-click menu on a supported document
7. Open `Paper2Slides/<source-file-name>/` in the vault after the run finishes

## Actual workflow

- PDFs run in `paper` mode
- Markdown (`.md`, `.markdown`) and text notes run in `general` mode
- The plugin starts `python3 -m paper2slides`
- `Paper2Slides` handles parsing, summary, planning, and generation
- The plugin imports the newest summary, PDFs, PNGs, and `last-run.log` back into the vault

## In-app controls

- **Settings tab**:
  - Python path, repo path, API provider, provider-specific endpoint and model settings
  - Output type, slides length, poster density, style, custom style prompt
  - Fast mode, parallel workers, import root, save run log
- **Ribbon button**:
  - **Generate** for the active supported document (presentation icon)
- **Right-click menu**:
  - Generate or re-import the latest outputs for a file
- **Command palette**:
  - Refresh provider models, test selected provider

## Setup notes

1. Clone the original `Paper2Slides` repo
2. Install its dependencies
3. Configure `paper2slides/.env`
4. Run `npm install`
5. Run `npm run build` and `npm test`
6. Copy `manifest.json`, `main.js`, and `versions.json` into `.obsidian/plugins/paper2slides-obsidian/`
7. Enable the plugin in Obsidian
8. Run `Check Paper2Slides setup` once before the first real job

## Provider overrides

If you do not want to rely on the upstream repo defaults, you can override the LLM endpoint directly in the plugin:

- `Z AI`
  - uses the International Coding Plan endpoint and lets you set the API key plus a model such as `glm-5.1`
- `LM Studio`
  - uses a local OpenAI-compatible endpoint, defaulting to `http://127.0.0.1:1234/v1`
- `Ollama`
  - uses a local OpenAI-compatible endpoint, defaulting to `http://localhost:11434/v1`
- `AnythingLLM`
  - lets you point Paper2Slides at your local AnythingLLM endpoint and model setup

For `LM Studio`, `Ollama`, and `AnythingLLM`, the settings tab can now test the endpoint and try to load the available model list directly.

## Credit

This repo only covers the Obsidian side of the workflow.

- Original project: [HKUDS/Paper2Slides](https://github.com/HKUDS/Paper2Slides)
- The actual slide generation pipeline lives there

Markdown, text, and `.docx` inputs are parsed directly on Windows, macOS, and Linux.
Update the Python dependencies with `pip install -r requirements.txt` in the configured
Paper2Slides checkout. DOCX does not require LibreOffice; older `.doc`, PowerPoint,
and Excel inputs still do. DOCX text, headings, tables, and embedded pictures are
included in the parsed output. The backend also accepts mixed uploads and tracks
progress/results for non-PDF sessions.
