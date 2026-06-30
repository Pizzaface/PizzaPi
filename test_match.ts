const deletedEntries = [
    { name: "oldServer", command: "node", args: ["foo.js"] },
    { name: "oldServer2", command: "bun", args: ["bar.js"] },
];
const newEntry = { name: "newServer", command: "node", args: ["foo.js"], env: { KEY: "***" } };

const matches = deletedEntries.filter(deleted => {
    return (
        deleted.command === newEntry.command &&
        deleted.url === newEntry.url &&
        JSON.stringify(deleted.args ?? []) === JSON.stringify(newEntry.args ?? [])
    );
});

console.log("Matches:", matches);
