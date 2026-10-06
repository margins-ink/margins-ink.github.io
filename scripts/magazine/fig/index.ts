// Entry for the figure compiler and emitter.
export { compileFigure, pathBounds, PROPS, CHAR_W, type CompiledFigureX, type LintItem } from './compile';
export { lintFigure } from './lint';
export { emitFigure, buildFigures, loadFigures, type FigureArt, type FigEnv } from './emit';
