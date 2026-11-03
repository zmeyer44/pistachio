// The page: opened by the worker as a desk window, at hello.html?name=…
const name = new URLSearchParams(location.search).get("name");
if (name) {
  document.getElementById("greeting").textContent = `Hello, ${name}!`;
  document.title = `Hello, ${name}`;
}
