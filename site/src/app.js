// Theme toggle + copy buttons. No dependencies, no network.
(function () {
  var root = document.documentElement
  var btn = document.getElementById("theme")
  if (btn) {
    btn.addEventListener("click", function () {
      var dark = getComputedStyle(root).colorScheme === "dark"
      var next = dark ? "light" : "dark"
      root.dataset.theme = next
      try { localStorage.setItem("theme", next) } catch (e) {}
    })
  }
  document.addEventListener("click", function (e) {
    var t = e.target
    if (!t || !t.hasAttribute || !t.hasAttribute("data-copy")) return
    var pre = t.closest("figure").querySelector("code")
    var text = pre ? pre.textContent : ""
    var done = function () { var o = t.textContent; t.textContent = "COPIED"; setTimeout(function () { t.textContent = o }, 1200) }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {})
    else {
      var ta = document.createElement("textarea")
      ta.value = text; document.body.appendChild(ta); ta.select()
      try { document.execCommand("copy"); done() } catch (x) {}
      document.body.removeChild(ta)
    }
  })
})()
