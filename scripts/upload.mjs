/**
 * Build & upload media from local ./media folder to Cloudflare R2.
 *
 * Layout the script expects:
 *
 *   v2/media/
 *     ├── Birthday/                 ← project (folder name = tag in index)
 *     │   ├── main/                 ← files here go on the main page (featured)
 *     │   │   └── cover.jpg
 *     │   ├── 01.jpg                ← shown only in index/viewer
 *     │   ├── 02.jpg
 *     │   └── intro.mp4
 *     ├── HFBK PROM 2022/
 *     │   ├── main/poster.jpg
 *     │   └── ...
 *     └── ...
 *
 * What it does:
 *   - For each project folder, processes every image (sharp → lo/mid/hi JPEG)
 *     and every video (ffmpeg → H.264 mp4 + poster JPG).
 *   - Uploads all variants to R2 under projects/{slug}/.
 *   - Skips already-uploaded objects (HEAD check) — re-running is safe & fast.
 *   - Files inside `main/` get `featured: true` in the manifest.
 *   - Writes public/projects.json — the runtime source of truth.
 *
 * Run:
 *     cd v2 && npm run upload
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { putObject, objectExists } from "./lib/r2-client.mjs";
import { makeImageVariants } from "./lib/sharp-variants.mjs";
import {
    extractPoster,
    getVideoDimensions,
    transcodeThumbVideo,
    transcodeVideo,
} from "./lib/ffmpeg-video.mjs";

const PROJECT_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const MEDIA_DIR = path.join(PROJECT_ROOT, "media");
const MANIFEST_PATH = path.join(PROJECT_ROOT, "public", "projects.json");

const MAIN_SUBFOLDER = "main";
const IMG_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const VID_EXT = new Set([".mp4", ".mov", ".m4v", ".webm"]);

const slugify = (s) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const stats = { uploaded: 0, skipped: 0, bytes: 0 };

/* ============================================================
   Upload helpers
   ============================================================ */

async function uploadIfNeeded(key, body) {
    if (await objectExists(key)) {
        stats.skipped++;
        return;
    }
    await putObject(key, body);
    stats.uploaded++;
    stats.bytes += body.length;
    process.stdout.write(`  ↑ ${key} (${(body.length / 1024).toFixed(1)} KB)\n`);
}

async function processImage(localPath, slug, baseName) {
    const buf = await fs.readFile(localPath);
    const variants = await makeImageVariants(buf);
    const base = `projects/${slug}/${baseName}`;
    await uploadIfNeeded(`${base}-lo.jpg`, variants.lo);
    await uploadIfNeeded(`${base}-mid.webp`, variants.mid);
    await uploadIfNeeded(`${base}.webp`, variants.hi);
    return {
        type: "image",
        id: base,
        w: variants.w,
        h: variants.h,
    };
}

async function processVideo(localPath, slug, baseName) {
    const [mp4, thumbMp4, poster, dims] = await Promise.all([
        transcodeVideo(localPath),
        transcodeThumbVideo(localPath),
        extractPoster(localPath),
        getVideoDimensions(localPath).catch(() => null),
    ]);
    const base = `projects/${slug}/${baseName}`;
    await uploadIfNeeded(`${base}.mp4`, mp4);
    await uploadIfNeeded(`${base}-mid.mp4`, thumbMp4);
    await uploadIfNeeded(`${base}-lo.jpg`, poster);
    const entry = { type: "video", id: base };
    if (dims) {
        entry.w = dims.w;
        entry.h = dims.h;
    }
    return entry;
}

/* ============================================================
   Walking the media tree
   ============================================================ */

/** Returns sorted list of regular files in `dir` (non-recursive, no hidden). */
async function listFiles(dir) {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries
            .filter((e) => e.isFile() && !e.name.startsWith("."))
            .map((e) => e.name)
            .sort();
    } catch (err) {
        if (err.code === "ENOENT") return [];
        throw err;
    }
}

/**
 * For a project folder, returns flat list of { localPath, featured }
 * featuring files inside `main/` first.
 */
async function collectProjectFiles(projectDir) {
    const mainDir = path.join(projectDir, MAIN_SUBFOLDER);
    const [mainFiles, restFiles] = await Promise.all([
        listFiles(mainDir),
        listFiles(projectDir),
    ]);

    const out = [];
    for (const name of mainFiles) {
        out.push({ localPath: path.join(mainDir, name), featured: true });
    }
    for (const name of restFiles) {
        out.push({ localPath: path.join(projectDir, name), featured: false });
    }
    return out;
}

async function readProjectMeta(projectDir) {
    try {
        const raw = await fs.readFile(path.join(projectDir, "meta.json"), "utf8");
        return JSON.parse(raw);
    } catch (err) {
        if (err.code === "ENOENT") return {};
        console.error(`  ! meta.json parse error: ${err.message}`);
        return {};
    }
}

async function processProject(displayName) {
    const slug = slugify(displayName);
    const projectDir = path.join(MEDIA_DIR, displayName);
    const [items, meta] = await Promise.all([
        collectProjectFiles(projectDir),
        readProjectMeta(projectDir),
    ]);

    if (items.length === 0) {
        console.log(`\n[${displayName}] empty, skip`);
        return null;
    }

    console.log(`\n[${displayName}] (slug: ${slug}, ${items.length} files)`);

    const files = [];
    // baseName строим из slugify(имя исходного файла без расширения), а не
    // из порядкового индекса. Это нужно чтобы перемещение файла в main/
    // (или любая другая перестановка) не сдвигало нумерацию: ключи в R2
    // остаются стабильными, uploadIfNeeded не отдаёт чужие байты под
    // прежним ключом.
    const usedBaseNames = new Set();
    const uniqueBaseName = (raw) => {
        const base = slugify(raw) || "file";
        if (!usedBaseNames.has(base)) {
            usedBaseNames.add(base);
            return base;
        }
        let i = 2;
        while (usedBaseNames.has(`${base}-${i}`)) i++;
        const out = `${base}-${i}`;
        usedBaseNames.add(out);
        return out;
    };

    for (const { localPath, featured } of items) {
        const ext = path.extname(localPath).toLowerCase();
        const baseName = uniqueBaseName(path.basename(localPath, ext));
        try {
            let entry;
            if (IMG_EXT.has(ext)) {
                entry = await processImage(localPath, slug, baseName);
            } else if (VID_EXT.has(ext)) {
                entry = await processVideo(localPath, slug, baseName);
            } else {
                continue;
            }
            if (featured) entry.featured = true;
            files.push(entry);
        } catch (err) {
            console.error(`  ✗ ${localPath}: ${err.message}`);
        }
    }

    if (files.length === 0) return null;

    const project = { tag: displayName, files };
    if (typeof meta.services === "string" && meta.services.trim()) {
        project.services = meta.services.trim();
    }
    if (typeof meta.position === "number") {
        project.position = meta.position;
    }
    if (meta.hideFromMain === true) {
        project.hideFromMain = true;
    }
    if (meta.previewOnly === true) {
        project.previewOnly = true;
    }
    if (meta.mute === true) {
        project.mute = true;
    }
    return project;
}

/* ============================================================
   Main
   ============================================================ */

async function main() {
    let projectDirs;
    try {
        const entries = await fs.readdir(MEDIA_DIR, { withFileTypes: true });
        projectDirs = entries
            .filter((e) => e.isDirectory() && !e.name.startsWith("."))
            .map((e) => e.name)
            .sort();
    } catch (err) {
        if (err.code === "ENOENT") {
            console.log(`No ./media directory at ${MEDIA_DIR}`);
            console.log(`Create it and put one folder per project inside.`);
            console.log(`See README for the expected layout.`);
            return;
        }
        throw err;
    }

    if (projectDirs.length === 0) {
        console.log("No project folders inside ./media. Nothing to upload.");
        return;
    }

    const projects = [];
    for (const dir of projectDirs) {
        const project = await processProject(dir);
        if (project) projects.push(project);
    }

    // Сортируем по meta.position (по возрастанию). Проекты без position —
    // в конец, среди них алфавитный порядок (как пришли с диска).
    projects.sort((a, b) => {
        const ap = typeof a.position === "number" ? a.position : Infinity;
        const bp = typeof b.position === "number" ? b.position : Infinity;
        return ap - bp;
    });

    await fs.writeFile(
        MANIFEST_PATH,
        JSON.stringify({ projects }, null, 4) + "\n",
        "utf8",
    );

    console.log("\n========================================");
    console.log(`Projects: ${projects.length}`);
    console.log(`Uploaded: ${stats.uploaded}, skipped (existed): ${stats.skipped}`);
    console.log(`Bytes uploaded: ${(stats.bytes / 1024 / 1024).toFixed(1)} MB`);
    console.log(`Manifest: ${MANIFEST_PATH}`);
}

main().catch((err) => {
    console.error("Upload failed:", err);
    process.exit(1);
});
