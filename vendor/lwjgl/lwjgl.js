// Ładowany przez System.loadLibrary("lwjgl") z java.library.path (jako lwjgl.js).
// Eksport { wasmModule: ArrayBuffer } wg wzorca browsercraft. Ścieżka do .so
// RELATYWNA do import.meta.url (URL, z którego ten moduł wczytano) – działa
// na GitHub Pages (podkatalog /mc-launcher/), na originie relay i w Worker.
const soUrl = new URL("liblwjgl.so", import.meta.url).href;
const r = await fetch(soUrl);
const buf = await r.arrayBuffer();
export default {
	wasmModule: buf
};
