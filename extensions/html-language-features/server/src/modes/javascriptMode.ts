/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LanguageModelCache, getLanguageModelCache } from '../languageModelCache';
import {
	SymbolInformation, SymbolKind, CompletionItem, Location, SignatureHelp, SignatureInformation, ParameterInformation,
	Definition, TextEdit, TextDocument, Diagnostic, DiagnosticSeverity, Range, CompletionItemKind, Hover,
	DocumentHighlight, DocumentHighlightKind, CompletionList, Position, FormattingOptions, FoldingRange, FoldingRangeKind, SelectionRange,
	LanguageMode, Settings, SemanticTokenData, Workspace, DocumentContext
} from './languageModes';
import { getWordAtText, isWhitespaceOnly, repeat } from '../utils/strings';
import { HTMLDocumentRegions } from './embeddedSupport';

import * as ts from 'typescript';
import { getSemanticTokens, getSemanticTokenLegend } from './javascriptSemanticTokens';

const JS_WORD_REGEX = /(-?\d*\.\d\w*)|([^\`\~\!\@\#\%\^\&\*\(\)\-\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)/g;

function getLanguageServiceHost(scriptKind: ts.ScriptKind) {
	const compilerOptions: ts.CompilerOptions = { allowNonTsExtensions: true, allowJs: true, lib: ['lib.es6.d.ts'], target: ts.ScriptTarget.Latest, moduleResolution: ts.ModuleResolutionKind.Classic, experimentalDecorators: false };

	let currentTextDocument = TextDocument.create('init', 'javascript', 1, '');
	const jsLanguageService = import(/* webpackChunkName: "javascriptLibs" */ './javascriptLibs').then(libs => {
		const host: ts.LanguageServiceHost = {
			getCompilationSettings: () => compilerOptions,
			getScriptFileNames: () => [currentTextDocument.uri, 'jquery'],
			getScriptKind: (fileName) => {
				if (fileName === currentTextDocument.uri) {
					return scriptKind;
				}
				return fileName.substr(fileName.length - 2) === 'ts' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
			},
			getScriptVersion: (fileName: string) => {
				if (fileName === currentTextDocument.uri) {
					return String(currentTextDocument.version);
				}
				return '1'; // default lib an jquery.d.ts are static
			},
			getScriptSnapshot: (fileName: string) => {
				let text = '';
				if (fileName === currentTextDocument.uri) {
					text = currentTextDocument.getText();
				} else {
					text = libs.loadLibrary(fileName);
				}
				return {
					getText: (start, end) => text.substring(start, end),
					getLength: () => text.length,
					getChangeRange: () => undefined
				};
			},
			getCurrentDirectory: () => '',
			getDefaultLibFileName: (_options: ts.CompilerOptions) => 'es6',
			readFile: (path: string, _encoding?: string | undefined): string | undefined => {
				if (path === currentTextDocument.uri) {
					return currentTextDocument.getText();
				} else {
					return libs.loadLibrary(path);
				}
			},
			fileExists: (path: string): boolean => {
				if (path === currentTextDocument.uri) {
					return true;
				} else {
					return !!libs.loadLibrary(path);
				}
			}
		};
		return ts.createLanguageService(host);
	});
	return {
		async getLanguageService(jsDocument: TextDocument): Promise<ts.LanguageService> {
			currentTextDocument = jsDocument;
			return jsLanguageService;
		},
		getCompilationSettings() {
			return compilerOptions;
		},
		dispose() {
			jsLanguageService.then(s => s.dispose());
		}
	};
}


export function getJavaScriptMode(documentRegions: LanguageModelCache<HTMLDocumentRegions>, languageId: 'javascript' | 'typescript', workspace: Workspace): LanguageMode {
	let jsDocuments = getLanguageModelCache<TextDocument>(10, 60, document => documentRegions.get(document).getEmbeddedDocument(languageId));

	const host = getLanguageServiceHost(languageId === 'javascript' ? ts.ScriptKind.JS : ts.ScriptKind.TS);
	let globalSettings: Settings = {};

	return {
		getId() {
			return languageId;
		},
		async doValidation(document: TextDocument, settings = workspace.settings): Promise<Diagnostic[]> {
			host.getCompilationSettings()['experimentalDecorators'] = settings && settings.javascript && settings.javascript.implicitProjectConfig.experimentalDecorators;
			const jsDocument = jsDocuments.get(document);
			const languageService = await host.getLanguageService(jsDocument);
			const syntaxDiagnostics: ts.Diagnostic[] = languageService.getSyntacticDiagnostics(jsDocument.uri);
			const semanticDiagnostics = languageService.getSemanticDiagnostics(jsDocument.uri);
			return syntaxDiagnostics.concat(semanticDiagnostics).filter(d => d.code !== 1108).map((diag: ts.Diagnostic): Diagnostic => {
				return {
					range: convertRange(jsDocument, diag),
					severity: DiagnosticSeverity.Error,
					source: languageId,
					message: ts.flattenDiagnosticMessageText(diag.messageText, '\n')
				};
			});
		},
		async doComplete(document: TextDocument, position: Position, _documentContext: DocumentContext): Promise<CompletionList> {
			const jsDocument = jsDocuments.get(document);
			const jsLanguageService = await host.getLanguageService(jsDocument);
			let offset = jsDocument.offsetAt(position);
			let completions = jsLanguageService.getCompletionsAtPosition(jsDocument.uri, offset, { includeExternalModuleExports: false, includeInsertTextCompletions: false });
			if (!completions) {
				return { isIncomplete: false, items: [] };
			}
			let replaceRange = convertRange(jsDocument, getWordAtText(jsDocument.getText(), offset, JS_WORD_REGEX));
			return {
				isIncomplete: false,
				items: completions.entries.map(entry => {
					return {
						uri: document.uri,
						position: position,
						label: entry.name,
						sortText: entry.sortText,
						kind: convertKind(entry.kind),
						textEdit: TextEdit.replace(replaceRange, entry.name),
						data: { // data used for resolving item details (see 'doResolve')
							languageId,
							uri: document.uri,
							offset: offset
						}
					};
				})
			};
		},
		async doResolve(document: TextDocument, item: CompletionItem): Promise<CompletionItem> {
			const jsDocument = jsDocuments.get(document);
			const jsLanguageService = await host.getLanguageService(jsDocument);
			let details = jsLanguageService.getCompletionEntryDetails(jsDocument.uri, item.data.offset, item.label, undefined, undefined, undefined, undefined);
			if (details) {
				item.detail = ts.displayPartsToString(details.displayParts);
				item.documentation = ts.displayPartsToString(details.documentation);
				delete item.data;
			}
			return item;
		},
		async doHover(document: TextDocument, position: Position): Promise<Hover | null> {
			const jsDocument = jsDocuments.get(document);
			const jsLanguageService = await host.getLanguageService(jsDocument);
			let info = jsLanguageService.getQuickInfoAtPosition(jsDocument.uri, jsDocument.offsetAt(position));
			if (info) {
				const contents = ts.displayPartsToString(info.displayParts);
				return {
					range: convertRange(jsDocument, info.textSpan),
					contents: ['```typescript', contents, '```'].join('\n')
				};
			}
			return null;
		},
		async doSignatureHelp(document: TextDocument, position: Position): Promise<SignatureHelp | null> {
			const jsDocument = jsDocuments.get(document);
			const jsLanguageService = await host.getLanguageService(jsDocument);
			let signHelp = jsLanguageService.getSignatureHelpItems(jsDocument.uri, jsDocument.offsetAt(position), undefined);
			if (signHelp) {
				let ret: SignatureHelp = {
					activeSignature: signHelp.selectedItemIndex,
					activeParameter: signHelp.argumentIndex,
					signatures: []
				};
				signHelp.items.forEach(item => {

					let signature: SignatureInformation = {
						label: '',
						documentation: undefined,
						parameters: []
					};

					signature.label += ts.displayPartsToString(item.prefixDisplayParts);
					item.parameters.forEach((p, i, a) => {
						let label = ts.displayPartsToString(p.displayParts);
						let parameter: ParameterInformation = {
							label: label,
							documentation: ts.displayPartsToString(p.documentation)
						};
						signature.label += label;
						signature.parameters!.push(parameter);
						if (i < a.length - 1) {
							signature.label += ts.displayPartsToString(item.separatorDisplayParts);
						}
					});
					signature.label += ts.displayPartsToString(item.suffixDisplayParts);
					ret.signatures.push(signature);
				});
				return ret;
			}
			return null;
		},
		async doRename(document: TextDocument, position: Position, newName: string) {
			const jsDocument = jsDocuments.get(document);
			const jsLanguageService = await host.getLanguageService(jsDocument);
			const jsDocumentPosition = jsDocument.offsetAt(position);
			const { canRename } = jsLanguageService.getRenameInfo(jsDocument.uri, jsDocumentPosition);
			if (!canRename) {
				return null;
			}
			const renameInfos = jsLanguageService.findRenameLocations(jsDocument.uri, jsDocumentPosition, false, false);

			const edits: TextEdit[] = [];
			renameInfos?.map(renameInfo => {
				edits.push({
					range: convertRange(jsDocument, renameInfo.textSpan),
					newText: newName,
				});
			});

			return {
				changes: { [document.uri]: edits },
			};
		},
		async findDocumentHighlight(document: TextDocument, position: Position): Promise<DocumentHighlight[]> {
			const jsDocument = jsDocuments.get(document);
			const jsLanguageService = await host.getLanguageService(jsDocument);
			const highlights = jsLanguageService.getDocumentHighlights(jsDocument.uri, jsDocument.offsetAt(position), [jsDocument.uri]);
			const out: DocumentHighlight[] = [];
			for (const entry of highlights || []) {
				for (const highlight of entry.highlightSpans) {
					out.push({
						range: convertRange(jsDocument, highlight.textSpan),
						kind: highlight.kind === 'writtenReference' ? DocumentHighlightKind.Write : DocumentHighlightKind.Text
					});
				}
			}
			return out;
		},
		async findDocumentSymbols(document: TextDocument): Promise<SymbolInformation[]> {
			const jsDocument = jsDocuments.get(document);
			const jsLanguageService = await host.getLanguageService(jsDocument);
			let items = jsLanguageService.getNavigationBarItems(jsDocument.uri);
			if (items) {
				let result: SymbolInformation[] = [];
				let existing = Object.create(null);
				let collectSymbols = (item: ts.NavigationBarItem, containerLabel?: string) => {
					let sig = item.text + item.kind + item.spans[0].start;
					if (item.kind !== 'script' && !existing[sig]) {
						let symbol: SymbolInformation = {
							name: item.text,
							kind: convertSymbolKind(item.kind),
							location: {
								uri: document.uri,
								range: convertRange(jsDocument, item.spans[0])
							},
							containerName: containerLabel
						};
						existing[sig] = true;
						result.push(symbol);
						containerLabel = item.text;
					}

					if (item.childItems && item.childItems.length > 0) {
						for (let child of item.childItems) {
							collectSymbols(child, containerLabel);
						}
					}

				};

				items.forEach(item => collectSymbols(item));
				return result;
			}
			return [];
		},
		async findDefinition(document: TextDocument, position: Position): Promise<Definition | null> {
			const jsDocument = jsDocuments.get(document);
			const jsLanguageService = await host.getLanguageService(jsDocument);
			let definition = jsLanguageService.getDefinitionAtPosition(jsDocument.uri, jsDocument.offsetAt(position));
			if (definition) {
				return definition.filter(d => d.fileName === jsDocument.uri).map(d => {
					return {
						uri: document.uri,
						range: convertRange(jsDocument, d.textSpan)
					};
				});
			}
			return null;
		},
		async findReferences(document: TextDocument, position: Position): Promise<Location[]> {
			const jsDocument = jsDocuments.get(document);
			const jsLanguageService = await host.getLanguageService(jsDocument);
			let references = jsLanguageService.getReferencesAtPosition(jsDocument.uri, jsDocument.offsetAt(position));
			if (references) {
				return references.filter(d => d.fileName === jsDocument.uri).map(d => {
					return {
						uri: document.uri,
						range: convertRange(jsDocument, d.textSpan)
					};
				});
			}
			return [];
		},
		async getSelectionRange(document: TextDocument, position: Position): Promise<SelectionRange> {
			const jsDocument = jsDocuments.get(document);
			const jsLanguageService = await host.getLanguageService(jsDocument);
			function convertSelectionRange(selectionRange: ts.SelectionRange): SelectionRange {
				const parent = selectionRange.parent ? convertSelectionRange(selectionRange.parent) : undefined;
				return SelectionRange.create(convertRange(jsDocument, selectionRange.textSpan), parent);
			}
			const range = jsLanguageService.getSmartSelectionRange(jsDocument.uri, jsDocument.offsetAt(position));
			return convertSelectionRange(range);
		},
		async format(document: TextDocument, range: Range, formatParams: FormattingOptions, settings: Settings = globalSettings): Promise<TextEdit[]> {
			const jsDocument = documentRegions.get(document).getEmbeddedDocument('javascript', true);
			const jsLanguageService = await host.getLanguageService(jsDocument);

			let formatterSettings = settings && settings.javascript && settings.javascript.format;

			let initialIndentLevel = computeInitialIndent(document, range, formatParams);
			let formatSettings = convertOptions(formatParams, formatterSettings, initialIndentLevel + 1);
			let start = jsDocument.offsetAt(range.start);
			let end = jsDocument.offsetAt(range.end);
			let lastLineRange = null;
			if (range.end.line > range.start.line && (range.end.character === 0 || isWhitespaceOnly(jsDocument.getText().substr(end - range.end.character, range.end.character)))) {
				end -= range.end.character;
				lastLineRange = Range.create(Position.create(range.end.line, 0), range.end);
			}
			let edits = jsLanguageService.getFormattingEditsForRange(jsDocument.uri, start, end, formatSettings);
			if (edits) {
				let result = [];
				for (let edit of edits) {
					if (edit.span.start >= start && edit.span.start + edit.span.length <= end) {
						result.push({
							range: convertRange(jsDocument, edit.span),
							newText: edit.newText
						});
					}
				}
				if (lastLineRange) {
					result.push({
						range: lastLineRange,
						newText: generateIndent(initialIndentLevel, formatParams)
					});
				}
				return result;
			}
			return [];
		},
		async getFoldingRanges(document: TextDocument): Promise<FoldingRange[]> {
			const jsDocument = jsDocuments.get(document);
			const jsLanguageService = await host.getLanguageService(jsDocument);
			let spans = jsLanguageService.getOutliningSpans(jsDocument.uri);
			let ranges: FoldingRange[] = [];
			for (let span of spans) {
				let curr = convertRange(jsDocument, span.textSpan);
				let startLine = curr.start.line;
				let endLine = curr.end.line;
				if (startLine < endLine) {
					let foldingRange: FoldingRange = { startLine, endLine };
					let match = document.getText(curr).match(/^\s*\/(?:(\/\s*#(?:end)?region\b)|(\*|\/))/);
					if (match) {
						foldingRange.kind = match[1] ? FoldingRangeKind.Region : FoldingRangeKind.Comment;
					}
					ranges.push(foldingRange);
				}
			}
			return ranges;
		},
		onDocumentRemoved(document: TextDocument) {
			jsDocuments.onDocumentRemoved(document);
		},
		async getSemanticTokens(document: TextDocument): Promise<SemanticTokenData[]> {
			const jsDocument = jsDocuments.get(document);
			const jsLanguageService = await host.getLanguageService(jsDocument);
			return [...getSemanticTokens(jsLanguageService, jsDocument, jsDocument.uri)];
		},
		getSemanticTokenLegend(): { types: string[]; modifiers: string[] } {
			return getSemanticTokenLegend();
		},
		dispose() {
			host.dispose();
			jsDocuments.dispose();
		}
	};
}




function convertRange(document: TextDocument, span: { start: number | undefined; length: number | undefined }): Range {
	if (typeof span.start === 'undefined') {
		const pos = document.positionAt(0);
		return Range.create(pos, pos);
	}
	const startPosition = document.positionAt(span.start);
	const endPosition = document.positionAt(span.start + (span.length || 0));
	return Range.create(startPosition, endPosition);
}

function convertKind(kind: string): CompletionItemKind {
	switch (kind) {
		case Kind.primitiveType:
		case Kind.keyword:
			return CompletionItemKind.Keyword;

		case Kind.const:
		case Kind.let:
		case Kind.variable:
		case Kind.localVariable:
		case Kind.alias:
		case Kind.parameter:
			return CompletionItemKind.Variable;

		case Kind.memberVariable:
		case Kind.memberGetAccessor:
		case Kind.memberSetAccessor:
			return CompletionItemKind.Field;

		case Kind.function:
		case Kind.localFunction:
			return CompletionItemKind.Function;

		case Kind.method:
		case Kind.constructSignature:
		case Kind.callSignature:
		case Kind.indexSignature:
			return CompletionItemKind.Method;

		case Kind.enum:
			return CompletionItemKind.Enum;

		case Kind.enumMember:
			return CompletionItemKind.EnumMember;

		case Kind.module:
		case Kind.externalModuleName:
			return CompletionItemKind.Module;

		case Kind.class:
		case Kind.type:
			return CompletionItemKind.Class;

		case Kind.interface:
			return CompletionItemKind.Interface;

		case Kind.warning:
			return CompletionItemKind.Text;

		case Kind.script:
			return CompletionItemKind.File;

		case Kind.directory:
			return CompletionItemKind.Folder;

		case Kind.string:
			return CompletionItemKind.Constant;

		default:
			return CompletionItemKind.Property;
	}
}
const enum Kind {
	alias = 'alias',
	callSignature = 'call',
	class = 'class',
	const = 'const',
	constructorImplementation = 'constructor',
	constructSignature = 'construct',
	directory = 'directory',
	enum = 'enum',
	enumMember = 'enum member',
	externalModuleName = 'external module name',
	function = 'function',
	indexSignature = 'index',
	interface = 'interface',
	keyword = 'keyword',
	let = 'let',
	localFunction = 'local function',
	localVariable = 'local var',
	method = 'method',
	memberGetAccessor = 'getter',
	memberSetAccessor = 'setter',
	memberVariable = 'property',
	module = 'module',
	primitiveType = 'primitive type',
	script = 'script',
	type = 'type',
	variable = 'var',
	warning = 'warning',
	string = 'string',
	parameter = 'parameter',
	typeParameter = 'type parameter'
}

function convertSymbolKind(kind: string): SymbolKind {
	switch (kind) {
		case Kind.module: return SymbolKind.Module;
		case Kind.class: return SymbolKind.Class;
		case Kind.enum: return SymbolKind.Enum;
		case Kind.enumMember: return SymbolKind.EnumMember;
		case Kind.interface: return SymbolKind.Interface;
		case Kind.indexSignature: return SymbolKind.Method;
		case Kind.callSignature: return SymbolKind.Method;
		case Kind.method: return SymbolKind.Method;
		case Kind.memberVariable: return SymbolKind.Property;
		case Kind.memberGetAccessor: return SymbolKind.Property;
		case Kind.memberSetAccessor: return SymbolKind.Property;
		case Kind.variable: return SymbolKind.Variable;
		case Kind.let: return SymbolKind.Variable;
		case Kind.const: return SymbolKind.Variable;
		case Kind.localVariable: return SymbolKind.Variable;
		case Kind.alias: return SymbolKind.Variable;
		case Kind.function: return SymbolKind.Function;
		case Kind.localFunction: return SymbolKind.Function;
		case Kind.constructSignature: return SymbolKind.Constructor;
		case Kind.constructorImplementation: return SymbolKind.Constructor;
		case Kind.typeParameter: return SymbolKind.TypeParameter;
		case Kind.string: return SymbolKind.String;
		default: return SymbolKind.Variable;
	}
}

function convertOptions(options: FormattingOptions, formatSettings: any, initialIndentLevel: number): ts.FormatCodeSettings {
	return {
		convertTabsToSpaces: options.insertSpaces,
		tabSize: options.tabSize,
		indentSize: options.tabSize,
		indentStyle: ts.IndentStyle.Smart,
		newLineCharacter: '\n',
		baseIndentSize: options.tabSize * initialIndentLevel,
		insertSpaceAfterCommaDelimiter: Boolean(!formatSettings || formatSettings.insertSpaceAfterCommaDelimiter),
		insertSpaceAfterConstructor: Boolean(formatSettings && formatSettings.insertSpaceAfterConstructor),
		insertSpaceAfterSemicolonInForStatements: Boolean(!formatSettings || formatSettings.insertSpaceAfterSemicolonInForStatements),
		insertSpaceBeforeAndAfterBinaryOperators: Boolean(!formatSettings || formatSettings.insertSpaceBeforeAndAfterBinaryOperators),
		insertSpaceAfterKeywordsInControlFlowStatements: Boolean(!formatSettings || formatSettings.insertSpaceAfterKeywordsInControlFlowStatements),
		insertSpaceAfterFunctionKeywordForAnonymousFunctions: Boolean(!formatSettings || formatSettings.insertSpaceAfterFunctionKeywordForAnonymousFunctions),
		insertSpaceBeforeFunctionParenthesis: Boolean(formatSettings && formatSettings.insertSpaceBeforeFunctionParenthesis),
		insertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis: Boolean(formatSettings && formatSettings.insertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis),
		insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets: Boolean(formatSettings && formatSettings.insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets),
		insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: Boolean(formatSettings && formatSettings.insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces),
		insertSpaceAfterOpeningAndBeforeClosingEmptyBraces: Boolean(!formatSettings || formatSettings.insertSpaceAfterOpeningAndBeforeClosingEmptyBraces),
		insertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces: Boolean(formatSettings && formatSettings.insertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces),
		insertSpaceAfterOpeningAndBeforeClosingJsxExpressionBraces: Boolean(formatSettings && formatSettings.insertSpaceAfterOpeningAndBeforeClosingJsxExpressionBraces),
		insertSpaceAfterTypeAssertion: Boolean(formatSettings && formatSettings.insertSpaceAfterTypeAssertion),
		placeOpenBraceOnNewLineForControlBlocks: Boolean(formatSettings && formatSettings.placeOpenBraceOnNewLineForFunctions),
		placeOpenBraceOnNewLineForFunctions: Boolean(formatSettings && formatSettings.placeOpenBraceOnNewLineForControlBlocks),
		semicolons: formatSettings?.semicolons
	};
}

function computeInitialIndent(document: TextDocument, range: Range, options: FormattingOptions) {
	let lineStart = document.offsetAt(Position.create(range.start.line, 0));
	let content = document.getText();

	let i = lineStart;
	let nChars = 0;
	let tabSize = options.tabSize || 4;
	while (i < content.length) {
		let ch = content.charAt(i);
		if (ch === ' ') {
			nChars++;
		} else if (ch === '\t') {
			nChars += tabSize;
		} else {
			break;
		}
		i++;
	}
	return Math.floor(nChars / tabSize);
}

function generateIndent(level: number, options: FormattingOptions) {
	if (options.insertSpaces) {
		return repeat(' ', level * options.tabSize);
	} else {
		return repeat('\t', level);
	}
}
