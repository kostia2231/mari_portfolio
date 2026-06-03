import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

if (ffmpegStatic) {
    ffmpeg.setFfmpegPath(ffmpegStatic);
}

/**
 * Reads video stream dimensions via ffprobe. iPhone portrait videos store
 * the frame rotated landscape with a rotation tag — apply that here so the
 * returned w/h match what the player actually shows.
 */
export async function getVideoDimensions(sourcePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(sourcePath, (err, data) => {
            if (err) return reject(err);
            const stream = (data.streams || []).find(
                (s) => s.codec_type === "video",
            );
            if (!stream) return reject(new Error("No video stream"));

            let w = stream.width;
            let h = stream.height;

            // ffprobe may report rotation either as side_data_list or tags.rotate.
            const sideRotate = (stream.side_data_list || []).find(
                (s) => typeof s.rotation === "number",
            );
            const rotation =
                (sideRotate && Math.abs(sideRotate.rotation)) ||
                Number(stream.tags?.rotate) ||
                0;
            if (rotation === 90 || rotation === 270) {
                [w, h] = [h, w];
            }
            resolve({ w, h });
        });
    });
}

/**
 * Transcodes a video to web-optimized H.264 MP4:
 *   - max height 720, aspect preserved (works for portrait + landscape)
 *   - HEVC / 10-bit / HDR → 8-bit yuv420p (universal browser playback)
 *   - 30 fps cap
 *   - faststart (moov atom upfront — browser plays before full download)
 *   - AAC stereo audio
 */
export async function transcodeVideo(sourcePath) {
    const outPath = path.join(tmpdir(), `${randomUUID()}.mp4`);

    try {
        await new Promise((resolve, reject) => {
            ffmpeg(sourcePath)
                .outputOptions([
                    "-vf",
                    "scale=-2:'min(720,ih)',format=yuv420p",
                    "-r",
                    "30",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "medium",
                    "-crf",
                    "23",
                    "-movflags",
                    "+faststart",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "128k",
                    "-ar",
                    "44100",
                    "-ac",
                    "2",
                ])
                .on("end", resolve)
                .on("error", (err, _stdout, stderr) => {
                    reject(
                        new Error(
                            `ffmpeg transcode failed: ${err.message}\n--- stderr ---\n${stderr || "(empty)"}\n--------------`,
                        ),
                    );
                })
                .save(outPath);
        });
        return await fs.readFile(outPath);
    } finally {
        await fs.unlink(outPath).catch(() => {});
    }
}

/**
 * Tiny low-bitrate clip for index thumbnails on hover.
 *   - 360px wide (covers retina @ 110px row height)
 *   - 24 fps, no audio, CRF 32 (very compressed)
 *   - faststart
 * Result ≈ 200-500 KB per video.
 */
export async function transcodeThumbVideo(sourcePath) {
    const outPath = path.join(tmpdir(), `${randomUUID()}.mp4`);

    try {
        await new Promise((resolve, reject) => {
            ffmpeg(sourcePath)
                .outputOptions([
                    "-vf",
                    "scale='min(360,iw)':-2,format=yuv420p",
                    "-r",
                    "24",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "fast",
                    "-crf",
                    "32",
                    "-movflags",
                    "+faststart",
                    "-an",
                ])
                .on("end", resolve)
                .on("error", (err, _stdout, stderr) => {
                    reject(
                        new Error(
                            `ffmpeg thumb transcode failed: ${err.message}\n--- stderr ---\n${stderr || "(empty)"}\n--------------`,
                        ),
                    );
                })
                .save(outPath);
        });
        return await fs.readFile(outPath);
    } finally {
        await fs.unlink(outPath).catch(() => {});
    }
}

/**
 * Extracts a poster frame at 1s into the video — 100px wide JPEG.
 * Matches the `-lo.jpg` photo variants visually so the cache key (lowResUrl)
 * pattern is consistent across image and video previews.
 */
export async function extractPoster(sourcePath) {
    const outPath = path.join(tmpdir(), `${randomUUID()}.jpg`);

    try {
        await new Promise((resolve, reject) => {
            ffmpeg(sourcePath)
                .seekInput("00:00:01")
                .frames(1)
                .outputOptions([
                    "-vf",
                    "scale=100:-2,format=yuvj420p",
                    "-q:v",
                    "8",
                ])
                .on("end", resolve)
                .on("error", (err, _stdout, stderr) => {
                    reject(
                        new Error(
                            `ffmpeg poster failed: ${err.message}\n--- stderr ---\n${stderr || "(empty)"}\n--------------`,
                        ),
                    );
                })
                .save(outPath);
        });
        return await fs.readFile(outPath);
    } finally {
        await fs.unlink(outPath).catch(() => {});
    }
}
