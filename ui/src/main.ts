// Neon Mission Control entry point.
// Phosphor icon-font weights (https://phosphoricons.com) must load before the
// app so <i class="ph ..."> glyphs render. Then the global design-system CSS,
// then the root custom element boots the app shell + router.
import "@phosphor-icons/web/regular";
import "@phosphor-icons/web/bold";
import "./styles/index.css";
import "./ui/app.ts";
