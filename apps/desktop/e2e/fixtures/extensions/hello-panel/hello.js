// The page (a desk window at hello.html?name=…): shows the name, and leaves "page.hello".
const name = new URLSearchParams(location.search).get("name") ?? "";
document.getElementById("greeting").textContent = name ? `Hello, ${name}!` : "Hello!";
if (name) document.title = `Hello, ${name}`;

pistachio.runtime.ready.then(() => pistachio.storage.local.set({ "page.hello": { name, context: pistachio.runtime.context } }));
