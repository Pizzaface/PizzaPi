import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const CALLBACK_NAMES = [
  "handleToggleDark",
  "handleShowApiKeys",
  "handleShowRunners",
  "handleShowShortcuts",
  "handleShowHiddenModels",
  "handleChangePassword",
  "handleToggleSidebar",
  "handleMobileShowApiKeys",
  "handleMobileShowRunners",
  "handleMobileShowHiddenModels",
  "handleMobileChangePassword",
  "handleSessionSwitcherOpenChange",
] as const;

describe("App auth guard hook ordering", () => {
  test("declares stable header callbacks before auth early returns", () => {
    const path = new URL("./App.tsx", import.meta.url);
    const sourceText = readFileSync(path, "utf8");
    const sourceFile = ts.createSourceFile(
      path.pathname,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );

    const appDecl = sourceFile.statements.find(
      (stmt): stmt is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(stmt) && stmt.name?.text === "App",
    );

    expect(appDecl).toBeDefined();
    expect(appDecl?.body).toBeDefined();

    const statements = appDecl!.body!.statements;
    const statementText = (index: number) => statements[index]!.getText(sourceFile);

    const pendingGuardIndex = statements.findIndex((stmt) =>
      ts.isIfStatement(stmt) && stmt.getText(sourceFile).startsWith("if (isPending)"),
    );
    const sessionGuardIndex = statements.findIndex((stmt) =>
      ts.isIfStatement(stmt) && stmt.getText(sourceFile).startsWith("if (!session)"),
    );

    expect(pendingGuardIndex).toBeGreaterThanOrEqual(0);
    expect(sessionGuardIndex).toBeGreaterThanOrEqual(0);

    for (const name of CALLBACK_NAMES) {
      const idx = statements.findIndex((stmt) =>
        ts.isVariableStatement(stmt) &&
        stmt.declarationList.declarations.some(
          (decl) => ts.isIdentifier(decl.name) && decl.name.text === name,
        ),
      );

      expect(idx, `${name} should be declared in App()`).toBeGreaterThanOrEqual(0);
      expect(
        idx,
        `${name} must stay above the isPending early return to preserve hook order.\nStatement was: ${idx >= 0 ? statementText(idx) : "<missing>"}`,
      ).toBeLessThan(pendingGuardIndex);
      expect(
        idx,
        `${name} must stay above the !session early return to preserve hook order.\nStatement was: ${idx >= 0 ? statementText(idx) : "<missing>"}`,
      ).toBeLessThan(sessionGuardIndex);
    }
  });
});
