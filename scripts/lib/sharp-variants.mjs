import sharp from "sharp";

const PRESETS = {
    lo: { width: 100, quality: 10 }, // blurry placeholder
    mid: { height: 800, quality: 75 },
    hi: { quality: 85, mozjpeg: true },
};

/**
 * Generates three JPEG variants from a source buffer.
 * Returns { lo, mid, hi, w, h } — w/h are post-rotation dimensions of the
 * hi-res output, used by the runtime to pre-size wrappers before image loads.
 */
export async function makeImageVariants(sourceBuffer) {
    // Hi variant first — also gives us authoritative output dimensions.
    const hiResult = await sharp(sourceBuffer)
        .rotate()
        .jpeg({ quality: PRESETS.hi.quality, mozjpeg: PRESETS.hi.mozjpeg })
        .toBuffer({ resolveWithObject: true });

    const lo = await sharp(sourceBuffer)
        .rotate()
        .resize({ width: PRESETS.lo.width, withoutEnlargement: true })
        .jpeg({ quality: PRESETS.lo.quality })
        .toBuffer();

    const mid = await sharp(sourceBuffer)
        .rotate()
        .resize({ height: PRESETS.mid.height, withoutEnlargement: true })
        .jpeg({ quality: PRESETS.mid.quality })
        .toBuffer();

    return {
        lo,
        mid,
        hi: hiResult.data,
        w: hiResult.info.width,
        h: hiResult.info.height,
    };
}
