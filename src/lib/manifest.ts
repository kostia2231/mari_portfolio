export type MediaType = "image" | "video";

export interface MediaFile {
    type: MediaType;
    /** Path in R2 without extension/suffix, e.g. "projects/birthday/01". */
    id: string;
    /**
     * True if this file is featured (was tagged `portfolio` / placed in `main/`)
     * — appears on the main page gallery. All files appear in the viewer.
     */
    featured?: boolean;
    /** Output width in pixels (post-rotation for videos). */
    w?: number;
    /** Output height in pixels. */
    h?: number;
}

export interface Project {
    /** Display name shown in index. */
    tag: string;
    /** Optional services / credits line shown in the viewer (e.g. "Art Direction, Producing"). */
    services?: string;
    /** Optional sort order — lower numbers first. Без значения — в конец. */
    position?: number;
    /** Hide from main gallery; still appears in index and via type filters. */
    hideFromMain?: boolean;
    /** If true, files in `main/` (featured) are used as preview only and excluded from the viewer/index thumb strip. */
    previewOnly?: boolean;
    /** If true, videos in this project are force-muted in the viewer and the Mute/Unmute button is hidden. */
    mute?: boolean;
    files: MediaFile[];
}

export interface Manifest {
    projects: Project[];
}

/** Fetches /projects.json (placed there by migrate.mjs / upload.mjs). */
export async function loadManifest(): Promise<Manifest> {
    const res = await fetch("/projects.json", { cache: "no-cache" });
    if (!res.ok) {
        throw new Error(`Failed to load /projects.json (${res.status})`);
    }
    return (await res.json()) as Manifest;
}
