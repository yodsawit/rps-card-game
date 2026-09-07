import "./style.css";
import { io } from "socket.io-client";
import { createApplication } from "./application.js";
import { startEffects } from "./fx.js";
import { GameAudio } from "./audio.js";

const app = document.querySelector<HTMLDivElement>("#app");
const toast = document.querySelector<HTMLDivElement>("#toast");
const audioControls = document.querySelector<HTMLDivElement>("#audio-controls");
if (!app || !toast || !audioControls) throw new Error("Application shell is missing.");
createApplication({ app, toast, socket: io({ transports: ["websocket", "polling"] }),
  effects: startEffects(), audio: new GameAudio(audioControls) });
