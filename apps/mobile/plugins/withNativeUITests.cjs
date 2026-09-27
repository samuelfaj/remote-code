const fs = require("node:fs/promises");
const path = require("node:path");
const { withXcodeProject } = require("expo/config-plugins");

const appTargetName = "RemoteCodeMobileProof";
const testTargetName = "RemoteCodeMobileProofUITests";
const testBundleId = "com.remotecode.mobileproof.uitests";

function unquote(value) {
  return typeof value === "string" ? value.replace(/^"|"$/g, "") : value;
}

function targetId(project, name) {
  const targets = project.pbxNativeTargetSection();
  return Object.keys(targets).find((id) => !id.endsWith("_comment") && unquote(targets[id].name) === name);
}

function removeAppToTestDependency(project, app, testId) {
  const dependencySection = project.hash.project.objects.PBXTargetDependency;
  const proxySection = project.hash.project.objects.PBXContainerItemProxy;
  app.target.dependencies = app.target.dependencies.filter((entry) => {
    const dependency = dependencySection[entry.value];
    if (!dependency || dependency.target !== testId) return true;
    delete dependencySection[entry.value];
    delete dependencySection[`${entry.value}_comment`];
    delete proxySection[dependency.targetProxy];
    delete proxySection[`${dependency.targetProxy}_comment`];
    return false;
  });
}

function addTestTarget(project) {
  const app = project.getTarget("com.apple.product-type.application");
  if (!app || unquote(app.target.name) !== appTargetName) {
    throw new Error(`Expected Expo application target ${appTargetName}`);
  }

  const existingTestId = targetId(project, testTargetName);
  const test = existingTestId
    ? { uuid: existingTestId, pbxNativeTarget: project.pbxNativeTargetSection()[existingTestId] }
    : project.addTarget(testTargetName, "unit_test_bundle", "Products", testBundleId);
  const testTarget = test.pbxNativeTarget;
  removeAppToTestDependency(project, app, test.uuid);
  if (!testTarget.dependencies.some((entry) => {
    const dependency = project.hash.project.objects.PBXTargetDependency[entry.value];
    return dependency?.target === app.uuid;
  })) project.addTargetDependency(test.uuid, [app.uuid]);

  testTarget.productType = '"com.apple.product-type.bundle.ui-testing"';
  const product = project.pbxFileReferenceSection()[testTarget.productReference];
  product.explicitFileType = '"wrapper.cfbundle"';

  const configurationList = project.pbxXCConfigurationList()[testTarget.buildConfigurationList];
  for (const configurationRef of configurationList.buildConfigurations) {
    const configuration = project.pbxXCBuildConfigurationSection()[configurationRef.value];
    delete configuration.buildSettings.INFOPLIST_FILE;
    Object.assign(configuration.buildSettings, {
      GENERATE_INFOPLIST_FILE: "YES",
      IPHONEOS_DEPLOYMENT_TARGET: "15.1",
      PRODUCT_BUNDLE_IDENTIFIER: `"${testBundleId}"`,
      SWIFT_VERSION: "5.0",
      TARGETED_DEVICE_FAMILY: '"1,2"',
      TEST_TARGET_NAME: appTargetName,
    });
  }
  project.addTargetAttribute("TestTargetID", app.uuid, { uuid: test.uuid });

  for (const [phaseType, name] of [["PBXSourcesBuildPhase", "Sources"], ["PBXFrameworksBuildPhase", "Frameworks"], ["PBXResourcesBuildPhase", "Resources"]]) {
    const phaseSection = project.hash.project.objects[phaseType];
    const phaseReferences = testTarget.buildPhases.filter((reference) => phaseSection[reference.value]);
    if (phaseReferences.length === 0) {
      project.addBuildPhase([], phaseType, name, test.uuid);
    } else if (phaseReferences.length > 1) {
      testTarget.buildPhases = testTarget.buildPhases.filter((reference) => !phaseSection[reference.value] || reference === phaseReferences[0]);
      for (const reference of phaseReferences.slice(1)) {
        delete phaseSection[reference.value];
        delete phaseSection[`${reference.value}_comment`];
      }
    }
  }

  const sourcePath = "../native-tests/RemoteCodeMobileProofUITests.swift";
  const sourceReference = Object.entries(project.pbxFileReferenceSection()).find(([id, file]) => !id.endsWith("_comment") && unquote(file.path) === sourcePath);
  if (sourceReference) {
    const sourceRefId = sourceReference[0];
    const appSources = project.pbxSourcesBuildPhaseObj(app.uuid);
    appSources.files = appSources.files.filter((buildFileRef) => {
      const buildFile = project.pbxBuildFileSection()[buildFileRef.value];
      return buildFile?.fileRef !== sourceRefId;
    });
    const testSourcesReference = testTarget.buildPhases.find((reference) => project.hash.project.objects.PBXSourcesBuildPhase[reference.value]);
    const testSources = project.hash.project.objects.PBXSourcesBuildPhase[testSourcesReference.value];
    const buildFiles = project.pbxBuildFileSection();
    const sourceBuildFile = Object.keys(buildFiles).find((id) => !id.endsWith("_comment") && buildFiles[id].fileRef === sourceRefId);
    if (!sourceBuildFile) throw new Error(`Missing build-file reference for ${sourcePath}`);
    if (!testSources.files.some((reference) => reference.value === sourceBuildFile)) {
      testSources.files.push({ value: sourceBuildFile, comment: "RemoteCodeMobileProofUITests.swift in Sources" });
    }
  } else {
    const mainGroup = project.getFirstProject().firstProject.mainGroup;
    project.addSourceFile(sourcePath, { target: test.uuid }, mainGroup);
  }
}

function schemeXml(appId, testId) {
  const reference = (id, target, product) => `
            <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${id}" BuildableName="${product}" BlueprintName="${target}" ReferencedContainer="container:${appTargetName}.xcodeproj"/>`;
  const appRef = reference(appId, appTargetName, `${appTargetName}.app`);
  const testRef = reference(testId, testTargetName, `${testTargetName}.xctest`);
  const buildEntry = (ref, isApp) => `
         <BuildActionEntry buildForTesting="YES" buildForRunning="${isApp ? "YES" : "NO"}" buildForProfiling="${isApp ? "YES" : "NO"}" buildForArchiving="${isApp ? "YES" : "NO"}" buildForAnalyzing="YES">${ref}
         </BuildActionEntry>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.7">
   <BuildAction parallelizeBuildables="NO" buildImplicitDependencies="YES">
      <BuildActionEntries>${buildEntry(appRef, true)}${buildEntry(testRef, false)}
      </BuildActionEntries>
   </BuildAction>
   <TestAction buildConfiguration="Release" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES">
      <Testables>
         <TestableReference skipped="NO" parallelizable="NO">${testRef}
         </TestableReference>
      </Testables>
      <EnvironmentVariables>
         <EnvironmentVariable key="RC_NATIVE_TEST_API_ORIGIN" value="http://127.0.0.1:39211" isEnabled="YES"/>
      </EnvironmentVariables>
   </TestAction>
   <LaunchAction buildConfiguration="Release" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" allowLocationSimulation="YES">
      <BuildableProductRunnable runnableDebuggingMode="0">${appRef}
      </BuildableProductRunnable>
   </LaunchAction>
   <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES">${appRef}
   </ProfileAction>
   <AnalyzeAction buildConfiguration="Debug"/>
   <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
`;
}

module.exports = function withNativeUITests(config) {
  return withXcodeProject(config, async (modConfig) => {
    const project = modConfig.modResults;
    addTestTarget(project);
    const appId = targetId(project, appTargetName);
    const testId = targetId(project, testTargetName);
    if (!appId || !testId) throw new Error("Generated Expo project is missing native UI-test targets");
    const projectRoot = modConfig.modRequest.platformProjectRoot;
    const schemeDirectory = path.join(projectRoot, `${appTargetName}.xcodeproj`, "xcshareddata", "xcschemes");
    await fs.mkdir(schemeDirectory, { recursive: true });
    await fs.writeFile(path.join(schemeDirectory, `${appTargetName}.xcscheme`), schemeXml(appId, testId));
    return modConfig;
  });
};
