import type { ResumePdfFonts } from './resume-pdf.js';

const fontPaths = {
  regular: '/fonts/NotoSans-Regular-subset.ttf',
  bold: '/fonts/NotoSans-Bold-subset.ttf',
} as const;

function toBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export async function loadResumePdfFonts(): Promise<ResumePdfFonts> {
  const loadFont = async (path: string) => {
    const response = await fetch(path, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Resume PDF font could not be loaded');
    return toBase64(await response.arrayBuffer());
  };
  const [regular, bold] = await Promise.all([
    loadFont(fontPaths.regular),
    loadFont(fontPaths.bold),
  ]);
  return { regular, bold };
}
