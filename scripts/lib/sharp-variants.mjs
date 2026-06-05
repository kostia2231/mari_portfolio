import sharp from "sharp";

const PRESETS = {
    lo:  { width: 100, quality: 10 },   // blurry placeholder — stays JPEG (video poster reuse)
    mid: { height: 800, quality: 80 },   // WebP
    hi:  { quality: 88 },                // WebP
};

/**
 * Generates three variants from a source buffer.
 * lo  → JPEG (tiny placeholder, also used as video poster)
 * mid → WebP h=800
 * hi  → WebP full-res
 * Returns { lo, mid, hi, w, h }
 */
export async function makeImageVariants(sourceBuffer) {
    // Hi variant first — authoritative output dimensions.
    const hiResult = await sharp(sourceBuffer)
        .rotate()
        .webp({ quality: PRESETS.hi.quality })
        .toBuffer({ resolveWithObject: true });

    const lo = await sharp(sourceBuffer)
        .rotate()
        .resize({ width: PRESETS.lo.width, withoutEnlargement: true })
        .jpeg({ quality: PRESETS.lo.quality })
        .toBuffer();

    const mid = await sharp(sourceBuffer)
        .rotate()
        .resize({ height: PRESETS.mid.height, withoutEnlargement: true })
        .webp({ quality: PRESETS.mid.quality })
        .toBuffer();

    return {
        lo,
        mid,
        hi: hiResult.data,
        w: hiResult.info.width,
        h: hiResult.info.height,
    };
}
