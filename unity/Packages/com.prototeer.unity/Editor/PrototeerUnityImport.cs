using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json.Linq;
using Unity.Behavior;
using UnityEditor;
using UnityEngine;

namespace Prototeer.Unity.Editor
{
    public static class PrototeerUnityImport
    {
        internal const string ImportRoot = "Assets/Prototeer Imports";
        private const string Extension = ".prototeer.json";
        private const string EditorVersion = "6000.6.10f1";
        private const string BehaviorVersion = "1.0.17";
        private const long MaximumBytes = 12 * 1024 * 1024;

        [MenuItem("Assets/Prototeer/Import Unity Export…", false, 2000)]
        private static void ImportMenu()
        {
            var selected = AssetDatabase.GetAssetPath(Selection.activeObject);
            var path = string.IsNullOrEmpty(selected) || !selected.EndsWith(Extension, StringComparison.OrdinalIgnoreCase)
                ? EditorUtility.OpenFilePanel("Import a Prototeer Unity export", "", "json")
                : Path.GetFullPath(selected);
            if (string.IsNullOrEmpty(path))
                return;

            try
            {
                var folder = ImportFile(path);
                Selection.activeObject = AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(folder);
                EditorGUIUtility.PingObject(Selection.activeObject);
            }
            catch (Exception error)
            {
                EditorUtility.DisplayDialog("Prototeer import", error.GetBaseException().Message, "Close");
            }
        }

        public static void ImportBatch()
        {
            var arguments = Environment.GetCommandLineArgs();
            var index = Array.IndexOf(arguments, "-prototeerImport");
            if (index < 0 || index + 1 >= arguments.Length)
                throw new InvalidOperationException("Pass -prototeerImport with a .prototeer.json file path.");
            var folder = ImportFile(arguments[index + 1]);
            Debug.Log("PROTOTEER IMPORT PASS: " + folder);
        }

        public static string ImportFile(string path)
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode)
                throw new InvalidOperationException("Exit Play Mode before importing a Prototeer project.");
            if (string.IsNullOrEmpty(path) || !path.EndsWith(Extension, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Select a .prototeer.json file from Export Unity.");

            var file = new FileInfo(path);
            if (!file.Exists || file.Length < 2 || file.Length > MaximumBytes)
                throw new InvalidDataException("Select a readable Prototeer export up to 12 MB.");
            var json = File.ReadAllText(file.FullName);
            var world = JObject.Parse(json, new JsonLoadSettings
            {
                DuplicatePropertyNameHandling = DuplicatePropertyNameHandling.Error,
            });
            ImportValidation.Check(world);
            RequireVersion();

            var name = SafeSegment((string)world["name"], "Prototeer project");
            var output = ImportRoot + "/" + name;
            if (AssetDatabase.IsValidFolder(output) || AssetDatabase.LoadMainAssetAtPath(output) != null
                || Directory.Exists(output) || File.Exists(output))
                throw new IOException($"'{output}' already exists. Move or rename that folder before importing. Its Unity edits will be kept.");

            if (!AssetDatabase.IsValidFolder(ImportRoot))
                AssetDatabase.CreateFolder("Assets", "Prototeer Imports");

            var folderGuid = AssetDatabase.CreateFolder(ImportRoot, name);
            var actualPath = AssetDatabase.GUIDToAssetPath(folderGuid);
            if (!string.Equals(actualPath, output, StringComparison.Ordinal))
            {
                if (!string.IsNullOrEmpty(actualPath))
                    AssetDatabase.DeleteAsset(actualPath);
                throw new IOException($"Unity could not create the new import folder '{output}'.");
            }

            try
            {
                var sourcePath = output + "/Source.prototeer.json";
                File.WriteAllText(sourcePath, json, new UTF8Encoding(false));
                AssetDatabase.ImportAsset(sourcePath, ImportAssetOptions.ForceSynchronousImport);
                var source = AssetDatabase.LoadAssetAtPath<TextAsset>(sourcePath)
                    ?? throw new IOException("Unity could not load the copied Prototeer JSON.");
                PrototeerProject.Parse(source);
                foreach (var tool in world["tools"])
                {
                    var id = (string)tool["id"];
                    var stem = SafeSegment((string)tool["name"], "Object")
                        + "-" + StableSuffix(id);
                    var graph = (bool)tool["brainEnabled"]
                        ? NativeGraphWriter.Create(tool, world, output + "/" + stem + " Graph.asset")
                        : null;
                    var definition = ScriptableObject.CreateInstance<PrototeerDefinitionAsset>();
                    definition.Initialize(source, id, graph);
                    AssetDatabase.CreateAsset(definition, output + "/" + stem + " Definition.asset");
                    AssetDatabase.SaveAssetIfDirty(definition);
                }
                return output;
            }
            catch
            {
                // The path was created exclusively for this import. Existing projects are never overwritten.
                AssetDatabase.DeleteAsset(output);
                throw;
            }
        }

        public static PrototeerBinding ApplyDefinition(GameObject target, PrototeerDefinitionAsset definition)
        {
            if (target == null || definition == null || definition.Source == null)
                throw new ArgumentException("Choose a scene object and an imported Prototeer definition.");
            if (EditorApplication.isPlayingOrWillChangePlaymode || EditorUtility.IsPersistent(target))
                throw new InvalidOperationException("Apply the definition to a scene object or open the prefab in Prefab Mode.");
            var agent = target.GetComponent<BehaviorGraphAgent>();
            var existing = target.GetComponent<PrototeerBinding>();
            if (agent != null && agent.Graph != null && agent.Graph != definition.Graph
                && (definition.Graph != null || existing != null && existing.Source != null))
                throw new InvalidOperationException("This GameObject already has a different Behavior Graph. Clear it or use another GameObject.");
            PrototeerProject.Parse(definition.Source);

            Undo.IncrementCurrentGroup();
            int undoGroup = Undo.GetCurrentGroup();
            Undo.SetCurrentGroupName("Apply Prototeer definition");
            var binding = existing ?? Undo.AddComponent<PrototeerBinding>(target);
            Undo.RecordObject(binding, "Assign Prototeer definition");
            binding.Configure(definition.Source, definition.DefinitionId);
            EditorUtility.SetDirty(binding);
            PrefabUtility.RecordPrefabInstancePropertyModifications(binding);
            if (definition.Graph != null)
            {
                agent ??= Undo.AddComponent<BehaviorGraphAgent>(target);
                Undo.RecordObject(agent, "Assign Prototeer graph");
                agent.Graph = definition.Graph;
                EditorUtility.SetDirty(agent);
                PrefabUtility.RecordPrefabInstancePropertyModifications(agent);
            }
            Undo.CollapseUndoOperations(undoGroup);
            return binding;
        }

        internal static void RequireVersion()
        {
            var installed = UnityEditor.PackageManager.PackageInfo.FindForAssembly(typeof(BehaviorGraph).Assembly)?.version;
            if (Application.unityVersion != EditorVersion || installed != BehaviorVersion)
                throw new InvalidOperationException($"Prototeer export currently targets Unity {EditorVersion} with Behavior {BehaviorVersion}. "
                    + $"Detected Unity {Application.unityVersion} with Behavior {installed ?? "missing"}.");
        }

        private static string SafeSegment(string value, string fallback)
        {
            var safe = new string((value ?? "").Where(c => char.IsLetterOrDigit(c) || c is ' ' or '_' or '-').ToArray()).Trim();
            if (safe.Length > 50)
                safe = safe.Substring(0, 50).TrimEnd();
            return safe.Length == 0 ? fallback : safe;
        }

        private static string StableSuffix(string id)
        {
            using var hash = SHA256.Create();
            return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(id)), 0, 6).Replace("-", "").ToLowerInvariant();
        }
    }
}
