var r = await fetch('/vendor/lwjgl/liblwjgl.so');
var buf = await r.arrayBuffer();
export default {
	wasmModule: buf
};
