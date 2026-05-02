import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Locale = "es" | "fr" | "pt-BR";
type Params = Record<string, string | number>;

const namespace = "pi-browser-harness";

const fallback = {
  "status.notStarted": "Browser daemon not started. Run /browser-setup first.",
  "status.browser": "Browser: {state}",
  "status.connected": "🟢 Connected",
  "status.disconnected": "🔴 Disconnected",
  "status.session": "Session: {sessionId}",
  "status.browserId": "Browser ID: {browserId}",
  "status.dialogOpen": "⚠️  Dialog open: {type} — \"{message}\"",
  "reload.notStarted": "Browser daemon not started.",
  "reload.start": "Restarting browser daemon...",
  "reload.done": "Browser daemon restarted ✓",
  "reload.failed": "Restart failed: {message}",
  "ui.connected": "🟢 Browser connected",
  "ui.setupNeeded": "🔴 Browser — run /browser-setup",
  "setup.command": "Connect pi to your Chrome browser",
  "setup.checking": "browser setup: checking Chrome...",
  "setup.notDetected": "Chrome/Chromium/Edge not detected. Please start your browser and retry /browser-setup.",
  "setup.running": "Chrome is running ✓",
  "setup.connecting": "Connecting to Chrome DevTools...",
  "setup.connected": "Connected to Chrome ✓",
  "setup.remoteDebugging": "Chrome remote debugging needs to be enabled.\n\nOpen chrome://inspect/#remote-debugging in your browser, tick the\n\"Discover network targets\" / Allow checkbox, then run /browser-setup again.\n\nOr set BU_CDP_WS to a remote browser WebSocket URL.",
  "setup.connectionFailed": "Connection failed: {message}",
  "setup.testing": "Testing browser control...",
  "setup.verified": "Browser control verified ✓\nNavigated to: {url}",
  "setup.testNavigationFailed": "Browser connected but test navigation failed: {message}",
} as const;

type Key = keyof typeof fallback;

const translations: Record<Locale, Partial<Record<Key, string>>> = {
  es: {
    "status.notStarted": "El daemon del navegador no se inició. Ejecuta /browser-setup primero.",
    "status.browser": "Navegador: {state}",
    "status.connected": "🟢 Conectado",
    "status.disconnected": "🔴 Desconectado",
    "status.session": "Sesión: {sessionId}",
    "status.browserId": "ID del navegador: {browserId}",
    "status.dialogOpen": "⚠️  Diálogo abierto: {type} — \"{message}\"",
    "reload.notStarted": "El daemon del navegador no se inició.",
    "reload.start": "Reiniciando daemon del navegador...",
    "reload.done": "Daemon del navegador reiniciado ✓",
    "reload.failed": "Error al reiniciar: {message}",
    "ui.connected": "🟢 Navegador conectado",
    "ui.setupNeeded": "🔴 Navegador — ejecuta /browser-setup",
    "setup.command": "Conectar pi a tu navegador Chrome",
    "setup.checking": "configuración del navegador: comprobando Chrome...",
    "setup.notDetected": "No se detectó Chrome/Chromium/Edge. Inicia el navegador y vuelve a ejecutar /browser-setup.",
    "setup.running": "Chrome está en ejecución ✓",
    "setup.connecting": "Conectando a Chrome DevTools...",
    "setup.connected": "Conectado a Chrome ✓",
    "setup.remoteDebugging": "La depuración remota de Chrome debe estar habilitada.\n\nAbre chrome://inspect/#remote-debugging en el navegador, marca\n\"Discover network targets\" / la casilla Allow y vuelve a ejecutar /browser-setup.\n\nO define BU_CDP_WS con una URL WebSocket de navegador remoto.",
    "setup.connectionFailed": "Conexión fallida: {message}",
    "setup.testing": "Probando control del navegador...",
    "setup.verified": "Control del navegador verificado ✓\nNavegado a: {url}",
    "setup.testNavigationFailed": "El navegador se conectó, pero la navegación de prueba falló: {message}",
  },
  fr: {
    "status.notStarted": "Le daemon du navigateur n’est pas démarré. Exécutez /browser-setup d’abord.",
    "status.browser": "Navigateur : {state}",
    "status.connected": "🟢 Connecté",
    "status.disconnected": "🔴 Déconnecté",
    "status.session": "Session : {sessionId}",
    "status.browserId": "ID du navigateur : {browserId}",
    "status.dialogOpen": "⚠️  Boîte de dialogue ouverte : {type} — \"{message}\"",
    "reload.notStarted": "Le daemon du navigateur n’est pas démarré.",
    "reload.start": "Redémarrage du daemon du navigateur...",
    "reload.done": "Daemon du navigateur redémarré ✓",
    "reload.failed": "Échec du redémarrage : {message}",
    "ui.connected": "🟢 Navigateur connecté",
    "ui.setupNeeded": "🔴 Navigateur — exécutez /browser-setup",
    "setup.command": "Connecter pi à votre navigateur Chrome",
    "setup.checking": "configuration du navigateur : vérification de Chrome...",
    "setup.notDetected": "Chrome/Chromium/Edge non détecté. Démarrez votre navigateur puis relancez /browser-setup.",
    "setup.running": "Chrome est en cours d’exécution ✓",
    "setup.connecting": "Connexion à Chrome DevTools...",
    "setup.connected": "Connecté à Chrome ✓",
    "setup.remoteDebugging": "Le débogage distant de Chrome doit être activé.\n\nOuvrez chrome://inspect/#remote-debugging dans votre navigateur, cochez\n\"Discover network targets\" / Allow, puis relancez /browser-setup.\n\nOu définissez BU_CDP_WS avec une URL WebSocket de navigateur distant.",
    "setup.connectionFailed": "Connexion échouée : {message}",
    "setup.testing": "Test du contrôle du navigateur...",
    "setup.verified": "Contrôle du navigateur vérifié ✓\nNavigation vers : {url}",
    "setup.testNavigationFailed": "Le navigateur est connecté, mais la navigation de test a échoué : {message}",
  },
  "pt-BR": {
    "status.notStarted": "O daemon do navegador não foi iniciado. Execute /browser-setup primeiro.",
    "status.browser": "Navegador: {state}",
    "status.connected": "🟢 Conectado",
    "status.disconnected": "🔴 Desconectado",
    "status.session": "Sessão: {sessionId}",
    "status.browserId": "ID do navegador: {browserId}",
    "status.dialogOpen": "⚠️  Diálogo aberto: {type} — \"{message}\"",
    "reload.notStarted": "O daemon do navegador não foi iniciado.",
    "reload.start": "Reiniciando daemon do navegador...",
    "reload.done": "Daemon do navegador reiniciado ✓",
    "reload.failed": "Falha ao reiniciar: {message}",
    "ui.connected": "🟢 Navegador conectado",
    "ui.setupNeeded": "🔴 Navegador — execute /browser-setup",
    "setup.command": "Conectar o pi ao seu navegador Chrome",
    "setup.checking": "configuração do navegador: verificando Chrome...",
    "setup.notDetected": "Chrome/Chromium/Edge não detectado. Inicie o navegador e tente /browser-setup novamente.",
    "setup.running": "Chrome está em execução ✓",
    "setup.connecting": "Conectando ao Chrome DevTools...",
    "setup.connected": "Conectado ao Chrome ✓",
    "setup.remoteDebugging": "A depuração remota do Chrome precisa estar ativada.\n\nAbra chrome://inspect/#remote-debugging no navegador, marque\n\"Discover network targets\" / Allow e execute /browser-setup novamente.\n\nOu defina BU_CDP_WS com uma URL WebSocket de navegador remoto.",
    "setup.connectionFailed": "Falha na conexão: {message}",
    "setup.testing": "Testando controle do navegador...",
    "setup.verified": "Controle do navegador verificado ✓\nNavegou para: {url}",
    "setup.testNavigationFailed": "O navegador conectou, mas a navegação de teste falhou: {message}",
  },
};

let currentLocale: string | undefined;

function format(template: string, params: Params = {}): string {
  return template.replace(/\{(\w+)\}/g, (_match, key) => String(params[key] ?? `{${key}}`));
}

export function t(key: Key, params?: Params): string {
  const locale = currentLocale as Locale | undefined;
  return format((locale ? translations[locale]?.[key] : undefined) ?? fallback[key], params);
}

export function initI18n(pi: ExtensionAPI): void {
  pi.events?.emit?.("pi-core/i18n/registerBundle", { namespace, defaultLocale: "en", fallback, translations });
  pi.events?.on?.("pi-core/i18n/localeChanged", (event: unknown) => {
    currentLocale = event && typeof event === "object" && "locale" in event ? String((event as { locale?: unknown }).locale ?? "") : undefined;
  });
  pi.events?.emit?.("pi-core/i18n/requestApi", { namespace, onApi(api: { getLocale?: () => string | undefined }) { currentLocale = api.getLocale?.(); } });
}
