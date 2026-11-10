// Leaf module: name constant only, no prompt/runtime imports, so
// constants-only consumers (constants/cheapModeTools.ts, tests) can load it
// without pulling pdfUtils → model/model.
export const FILE_READ_TOOL_NAME = 'Read'
