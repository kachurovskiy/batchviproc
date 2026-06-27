# Desktop batch video compression tool

[Download the latest release](https://github.com/kachurovskiy/batchviproc/releases/latest)

batchviproc scans a selected folder for videos and recompresses them one-by-one with ffmpeg. It preserves file metadata and creation, modification, and access dates where possible.

<img src="https://github.com/user-attachments/assets/c2dfa6da-d81e-4ec3-a631-e16d75878367" />

## Features

- Finds `.mp4`, `.mts`, `.m2ts`, `.flv`, and `.m4v` videos recursively.
- Sorts the queue by largest files first.
- Skips videos already recorded in the processed history.
- Lets you choose quality and encoding speed before starting a batch.
- Shows live queue, progress, current file, space saved, and failures.
- Stops an active batch and removes temporary output from failed or stopped runs.
- Keeps the original video when the recompressed output is not smaller.

## Development

Make sure you have Git, Node.js, and npm installed.

```bash
git clone https://github.com/kachurovskiy/batchviproc.git
cd batchviproc
npm install
npm start
```

Run the syntax checks:

```bash
npm run check
```

## Building and Releasing

```bash
npm run dist
```

Local builds are written to `dist/` and are not published.

To publish a portable Windows EXE to GitHub Releases, set a GitHub token with repository release permissions and run:

```powershell
$env:GH_TOKEN = "your-token"
npm run release
```

The release artifact is named from the package version, for example `batchviproc-1.1.0-portable.exe`.
