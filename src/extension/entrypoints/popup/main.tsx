import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initTheme } from "../../lib/theme";
import "../../global.css";

// 挂载前同步系统主题,避免首帧闪白(主站 main.tsx 里同样的防闪烁处理)
initTheme();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
