// webtorrent-backend/server.js

import WebTorrent from "webtorrent";
import express, { json } from "express";
import cors from "cors";
import path from "path";
import fs from "fs";

const app = express();
// Use environment variable for port in production (e.g., set by EC2/PM2).
// Defaults to 8081 if not set.
const port = process.env.PORT || 8081;

const client = new WebTorrent();

// Configure CORS to allow requests from your frontend.
// IMPORTANT: For production, replace 'http://localhost:8080' with your actual frontend domain (e.g., 'https://your-music-player-frontend.com').
// If your frontend is also on EC2, you might use its public DNS/IP here.
app.use(
  cors({
    origin: "http://localhost:8080", // Adjust this for your deployed frontend URL
  })
);

app.use(json()); // Middleware to parse JSON request bodies

// A simple in-memory store for active torrents.
// In a more complex production scenario, you might want a persistent store
// or a more sophisticated torrent management system.
const activeTorrents = {};

// Event listener for global WebTorrent client errors.
client.on("error", (err) => {
  console.error("WebTorrent Backend Client Error:", err.message);
});

/**
 * POST /api/add-torrent
 * Adds a torrent to the WebTorrent client on the backend.
 * Fetches metadata and returns file information to the frontend.
 * If the torrent is already being downloaded, it returns its existing metadata.
 */
app.post("/api/add-torrent", (req, res) => {
  const { magnetURI } = req.body;

  if (!magnetURI) {
    return res.status(400).json({ error: "Magnet URI is required." });
  }

  // Check if torrent is already active in the client
  const existingTorrent = client.get(magnetURI);
  if (existingTorrent.infoHash != undefined) {
    console.log("Torrent already active:", existingTorrent.infoHash);
    // If metadata is already available, respond immediately
    if (existingTorrent.metadata) {
      return res.json({
        infoHash: existingTorrent.infoHash,
        name: existingTorrent.name,
        files: existingTorrent.files.map((f) => ({
          name: f.name,
          length: f.length,
          path: f.path, // Path relative to the torrent root
        })),
      });
    }
    // If torrent is added but metadata not yet ready, wait for metadata event
    // This scenario is handled by the 'metadata' event listener below.
  }

  console.log("Adding torrent to backend:", magnetURI);
  let torrent = client.get(magnetURI);

  if (!torrent) {
    torrent = client.add(magnetURI);
  }

  // Event listener for when torrent metadata is ready.
  // This is crucial for getting file names before full download.
  torrent.on("metadata", () => {
    console.log(
      "Torrent metadata ready in backend:",
      torrent.name,
      torrent.infoHash
    );
    activeTorrents[torrent.infoHash] = torrent; // Store the torrent instance

    // Respond with metadata (file names, paths, lengths)
    if (!res.headersSent) {
      // Ensure response hasn't been sent by a timeout
      res.json({
        infoHash: torrent.infoHash,
        name: torrent.name,
        files: torrent.files.map((f) => ({
          name: f.name,
          length: f.length,
          path: f.path, // Path relative to the torrent root
        })),
      });
    }
  });

  // Event listener for torrent-specific errors.
  torrent.on("error", (err) => {
    console.error("Torrent specific error in backend:", err.message);
    if (!res.headersSent) {
      // Only send error if response hasn't been sent
      res.status(500).json({
        error: `Failed to add torrent or fetch metadata: ${err.message}`,
      });
    }
  });

  // Set a timeout for metadata fetching. If no metadata received within this time,
  // assume failure and clean up.
  setTimeout(() => {
    if (!torrent.metadata && !res.headersSent) {
      console.warn("Backend metadata timeout for torrent:", magnetURI);
      // Destroy the torrent instance to free up resources
      torrent.destroy(() => {
        console.log("Timed out torrent destroyed:", torrent.infoHash);
        delete activeTorrents[torrent.infoHash]; // Remove from active list
      });
      res.status(504).json({
        error:
          "Torrent metadata timed out in backend. Could not connect to peers or trackers.",
      });
    }
  }, 30000); // 30 seconds timeout for metadata
});

/**
 * GET /api/stream/:infoHash/:fileIndex
 * Streams a specific file from a downloaded (or partially downloaded) torrent.
 * Supports byte range requests for seeking in audio/video.
 */
app.get("/api/stream/:infoHash/:fileIndex", (req, res) => {
  const { infoHash, fileIndex } = req.params;
  const torrent = activeTorrents[infoHash];

  if (!torrent || !torrent.files[fileIndex]) {
    console.error(
      `Stream request: Torrent ${infoHash} or file index ${fileIndex} not found.`
    );
    return res
      .status(404)
      .send("File not found or torrent not active on server.");
  }

  const file = torrent.files[fileIndex];
  console.log(
    `Attempting to stream file from backend: ${
      file.name
    } (Torrent: ${infoHash.substring(0, 8)}...)`
  );

  // Set HTTP headers for streaming.
  // 'Content-Type' is important for the browser to know how to play the file.
  // 'Content-Length' is the total size of the file.
  // 'Accept-Ranges' indicates that the server supports byte range requests (for seeking).
  res.setHeader("Content-Type", file.mimetype || "application/octet-stream");
  res.setHeader("Content-Length", file.length);
  res.setHeader("Accept-Ranges", "bytes");

  // Handle byte range requests (e.g., when the user seeks in the audio player).
  if (req.headers.range) {
    const range = req.headers.range; // e.g., "bytes=0-1023"
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : file.length - 1;
    const chunkSize = end - start + 1;

    res.setHeader("Content-Range", `bytes ${start}-${end}/${file.length}`);
    res.setHeader("Content-Length", chunkSize);
    res.status(206); // 206 Partial Content for range requests

    // Create a read stream for the specific byte range and pipe it to the response.
    file.createReadStream({ start, end }).pipe(res);
  } else {
    // If no range is requested, stream the entire file.
    file.createReadStream().pipe(res);
  }

  // Optional: Log torrent download progress for debugging/monitoring
  torrent.on("download", () => {
    // console.log(`Backend Download Progress for ${torrent.name}: ${(torrent.progress * 100).toFixed(2)}% - ${ (torrent.downloadSpeed / 1024).toFixed(2) } KB/s`);
  });

  torrent.on("done", () => {
    console.log(`Backend: Torrent "${torrent.name}" finished downloading.`);
  });
});

// Start the Express server.
app.listen(port, () => {
  console.log(`WebTorrent backend listening on http://localhost:${port}`);
  console.log(
    "Remember to configure CORS origin if deploying to a different domain!"
  );
});
