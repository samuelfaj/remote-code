import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./features/actions/App";
import "./features/actions/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
