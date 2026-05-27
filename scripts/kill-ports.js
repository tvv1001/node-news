import { execFileSync } from 'node:child_process';

function listPidsForPort(port) {
	try {
		const output = execFileSync('fuser', ['-n', 'tcp', String(port)], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		return [...new Set(output.split(/\s+/).map((value) => value.trim()).filter(Boolean))].map((value) => Number(value)).filter(Number.isInteger);
	} catch (error) {
		return [];
	}
}

function isProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return false;
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killPid(pid) {
	if (!isProcessAlive(pid)) return;
	process.kill(pid, 'SIGTERM');

	for (let attempt = 0; attempt < 10; attempt += 1) {
		if (!isProcessAlive(pid)) return;
		await sleep(100);
	}

	if (isProcessAlive(pid)) {
		process.kill(pid, 'SIGKILL');
	}
}

async function main() {
	const ports = process.argv.slice(2).map((value) => Number.parseInt(value, 10)).filter(Number.isInteger);
	if (!ports.length) return;

	const pids = [...new Set(ports.flatMap((port) => listPidsForPort(port)))];
	for (const pid of pids) {
		await killPid(pid);
	}
}

await main();
