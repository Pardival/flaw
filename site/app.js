// Langue (français par défaut, anglais si le navigateur le préfère) et système mis en avant.
(function () {
  var lang = (navigator.language || "fr").slice(0, 2) === "fr" ? "fr" : "en";
  try {
    lang = localStorage.getItem("flaw.lang") || lang;
  } catch (error) {
    // Stockage indisponible : langue du navigateur.
  }
  var button = document.getElementById("lang");

  function apply(next) {
    lang = next;
    document.documentElement.lang = next;
    document.querySelectorAll("[data-fr]").forEach(function (node) {
      node.textContent = node.getAttribute("data-" + next);
    });
    button.textContent = next === "fr" ? "EN" : "FR";
    button.setAttribute("aria-label", next === "fr" ? "English" : "Français");
    document.title = next === "fr" ? "Flaw — écrire sur une vraie page" : "Flaw — write on a real page";
  }

  button.addEventListener("click", function () {
    var next = lang === "fr" ? "en" : "fr";
    try {
      localStorage.setItem("flaw.lang", next);
    } catch (error) {
      // Rien : la langue vaut pour cette visite.
    }
    apply(next);
  });
  if (lang !== "fr") {
    apply(lang);
  }

  var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent;
  var preferred = /win/i.test(platform) ? "dl-win" : /mac/i.test(platform) ? "dl-mac" : null;
  if (preferred) {
    document.getElementById(preferred).classList.add("preferred");
  }
})();
