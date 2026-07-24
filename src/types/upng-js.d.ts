// Minimal ambient declaration for upng-js (ships no types). We use encode for
// palette-quantized PNG output and decode only in tests.
declare module 'upng-js' {
  interface UPNGImage {
    width: number;
    height: number;
    depth: number;
    ctype: number;
    data: Uint8Array;
  }
  const UPNG: {
    /** Encode RGBA frame buffers to PNG. cnum = palette size (0 = lossless
     *  24/32-bit; >0 quantizes to that many colors, producing an indexed PNG). */
    encode(imgs: ArrayBuffer[], width: number, height: number, cnum: number, dels?: number[]): ArrayBuffer;
    decode(buffer: ArrayBuffer | Uint8Array): UPNGImage;
    toRGBA8(img: UPNGImage): ArrayBuffer[];
  };
  export default UPNG;
}
