import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { NotifyProvider } from "./utils/notify";
import { Toaster } from "./components/Toast";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <NotifyProvider>
        <App />
        <Toaster />
      </NotifyProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
