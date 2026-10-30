/* global document, navigator, localStorage */
// Langue (français par défaut, anglais si le navigateur le préfère) et système mis en avant.
(function () {
  // Anglais par défaut ; le français reste à un clic (bouton FR), et le choix est retenu.
  var lang = "en";
  try {
    lang = localStorage.getItem("flaw.lang") || lang;
  } catch {
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
    document.querySelectorAll("img[data-src-fr]").forEach(function (img) {
      img.src = img.getAttribute("data-src-" + next);
    });
    var video = document.querySelector("video[data-src-fr]");
    if (video) {
      video.poster = video.getAttribute("data-poster-" + next);
      video.querySelector("source").src = video.getAttribute("data-src-" + next);
      video.load();
    }
  }

  button.addEventListener("click", function () {
    var next = lang === "fr" ? "en" : "fr";
    try {
      localStorage.setItem("flaw.lang", next);
    } catch {
      // Rien : la langue vaut pour cette visite.
    }
    apply(next);
  });
  if (lang !== "en") {
    apply(lang);
  }

  var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent;
  var preferred = /win/i.test(platform) ? "dl-win" : /mac/i.test(platform) ? "dl-mac" : null;
  if (preferred) {
    document.getElementById(preferred).classList.add("preferred");
  }
})();
