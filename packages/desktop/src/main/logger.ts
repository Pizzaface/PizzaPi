import log from "electron-log/main.js";

log.initialize();
log.transports.file.level = "info";
log.transports.console.level = "debug";

export default log;
