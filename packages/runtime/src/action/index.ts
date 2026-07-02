// @ziner/runtime — action
//
// Agent execution actions: GUI automation (mouse/keyboard/clipboard).

export { createNoopGUIProvider, createDesktopGUIProvider } from './gui';
export type { IGUIProvider, GUIAction, GUIActionType, GUIResult } from './gui';
