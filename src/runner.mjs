const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function hasUnsafeCode(code) {
  return /process\.env|child_process|exec\s*\(|spawn\s*\(|https:\/\/attacker\.invalid|fs\.|writeFile|readFile/i.test(code);
}

function event(title, status = "passed", detail = "") {
  return { id: crypto.randomUUID(), title, status, detail, timestamp: new Date().toISOString() };
}

export async function executeRun(run, { emit }) {
  const startedAt = Date.now();
  const publish = (nextEvent) => {
    run.events.push(nextEvent);
    emit(nextEvent);
  };
  const move = async (title, detail = "") => {
    run.status = "running";
    publish(event(title, "running", detail));
    await delay(260);
    publish(event(title, "passed", detail));
  };

  run.status = "preparing";
  await move("Environment prepared", "Disposable demo execution session created");
  await move("Browser started", "Chromium simulation · headed preview unavailable in demo mode");

  if (hasUnsafeCode(run.generation.code) || run.generation.scenarioId === "scenario-004") {
    publish(event("Security policy check", "failed", "Generated code attempted secret access or an external network request"));
    run.status = "security_rejected";
    run.errorClassification = "security_policy_violation";
    run.result = { passed: false, message: "The generated artifact was rejected before browser execution." };
  } else if (run.generation.scenarioId === "scenario-003") {
    await move("Target application loaded", "Workshop Shop");
    publish(event("Unsupported feature detected", "failed", "Export and email are not part of the supplied application context"));
    run.status = "failed";
    run.errorClassification = "generated_code_assumption";
    run.result = { passed: false, message: "The test could not reach a state supported by the target context." };
  } else {
    await move("Target application loaded", "Workshop Shop · demo-shop-v1");
    for (const step of run.generation.testPlan) {
      await move(step, run.generation.scenarioId === "scenario-002" ? "Action completed, but coverage may be incomplete" : "Observed in the demo execution plan");
    }
    run.status = "passed";
    run.result = {
      passed: true,
      message: run.generation.scenarioId === "scenario-002"
        ? "The test passed, but a passing result does not prove that the core behavior was checked."
        : "The generated scenario completed successfully.",
    };
  }

  run.durationMs = Date.now() - startedAt;
  run.completedAt = new Date().toISOString();
  run.done = true;
  publish(event("Execution completed", run.status === "passed" ? "passed" : "failed", run.result?.message || run.errorClassification));
}
