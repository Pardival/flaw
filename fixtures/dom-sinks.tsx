/**
 * Fixture SEC-WEB-07. Ce fichier est volontairement invalide.
 * Il est ignoré par `eslint .` et doit être rejeté par scripts/check-dom-sink-lint.mjs.
 */
const el = document.createElement("div");
el.innerHTML = "<p>x</p>";
el.outerHTML = "<div></div>";
el.insertAdjacentHTML("beforeend", "<span></span>");
el["innerHTML"] = "<p>x</p>";
el["outerHTML"] = "<div></div>";
el["insertAdjacentHTML"]("beforeend", "<span></span>");
document.write("<p>x</p>");
document.writeln("<p>x</p>");
document["write"]("<p>x</p>");
document["writeln"]("<p>x</p>");
eval("1");
window.eval("1");
const constructed = new Function("return 1");
const constructedBare = Function("return 1");
setTimeout("1", 0);
const view = <div dangerouslySetInnerHTML={{ __html: "<p>x</p>" }} />;
const props = { dangerouslySetInnerHTML: { __html: "<p>x</p>" } };
void el;
void constructed;
void constructedBare;
void view;
void props;
