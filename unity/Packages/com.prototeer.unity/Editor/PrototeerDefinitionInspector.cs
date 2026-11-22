using System;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Unity.Behavior;
using UnityEditor;
using UnityEngine;

namespace Prototeer.Unity.Editor
{
    [CustomEditor(typeof(PrototeerDefinitionAsset))]
    internal sealed class PrototeerDefinitionInspector : UnityEditor.Editor
    {
        private GameObject targetObject;
        private (string Name, string Id)[] zones = Array.Empty<(string, string)>();

        private void OnEnable()
        {
            var definition = (PrototeerDefinitionAsset)target;
            if (definition.Source == null)
                return;

            try
            {
                var document = JObject.Parse(definition.Source.text);
                var tool = (document["tools"] as JArray)?.FirstOrDefault(item =>
                    (string)item["id"] == definition.DefinitionId);
                if (tool == null || document["zones"] is not JArray zoneDefinitions)
                    return;

                var ids = (tool["allowedMovementZones"]?.Values<string>() ?? Enumerable.Empty<string>())
                    .Concat((tool["brain"] as JArray ?? new JArray())
                        .Where(node => (string)node["type"] == "action" && (string)node["action"] == "chooseTarget")
                        .SelectMany(node => node["selectionZones"]?.Values<string>() ?? Enumerable.Empty<string>()))
                    .ToHashSet(StringComparer.Ordinal);
                zones = zoneDefinitions
                    .Where(zone => ids.Contains((string)zone["id"]))
                    .Select(zone => ((string)zone["name"], (string)zone["id"]))
                    .ToArray();
            }
            catch (JsonException)
            {
                // Applying the definition runs the importer validation and reports malformed source.
            }
        }

        public override void OnInspectorGUI()
        {
            var definition = (PrototeerDefinitionAsset)target;
            using (new EditorGUI.DisabledScope(true))
                EditorGUILayout.ObjectField("Behavior Graph", definition.Graph, typeof(BehaviorGraph), false);
            if (definition.Graph != null && GUILayout.Button("Open in Unity Behavior"))
                AssetDatabase.OpenAsset(definition.Graph);
            if (zones.Length > 0)
            {
                EditorGUILayout.LabelField("Scene zones", EditorStyles.boldLabel);
                foreach (var (name, id) in zones)
                {
                    EditorGUILayout.LabelField(name);
                    using (new EditorGUILayout.HorizontalScope())
                    {
                        EditorGUILayout.SelectableLabel(id, EditorStyles.textField,
                            GUILayout.Height(EditorGUIUtility.singleLineHeight));
                        if (GUILayout.Button("Copy ID", GUILayout.Width(64)))
                            EditorGUIUtility.systemCopyBuffer = id;
                    }
                }
            }
            targetObject = (GameObject)EditorGUILayout.ObjectField("Apply to GameObject", targetObject, typeof(GameObject), true);
            using (new EditorGUI.DisabledScope(targetObject == null))
                if (GUILayout.Button("Apply Definition"))
                {
                    try
                    {
                        PrototeerUnityImport.ApplyDefinition(targetObject, definition);
                        Selection.activeGameObject = targetObject;
                    }
                    catch (Exception error)
                    {
                        EditorUtility.DisplayDialog("Prototeer definition", error.GetBaseException().Message, "Close");
                    }
                }
        }
    }

    [CustomEditor(typeof(PrototeerBinding))]
    internal sealed class PrototeerBindingInspector : UnityEditor.Editor
    {
        private PrototeerDefinitionAsset definition;

        public override void OnInspectorGUI()
        {
            definition = (PrototeerDefinitionAsset)EditorGUILayout.ObjectField("Prototeer definition", definition,
                typeof(PrototeerDefinitionAsset), false);
            using (new EditorGUI.DisabledScope(definition == null))
                if (GUILayout.Button("Apply Definition"))
                {
                    try
                    {
                        PrototeerUnityImport.ApplyDefinition(((PrototeerBinding)target).gameObject, definition);
                    }
                    catch (Exception error)
                    {
                        EditorUtility.DisplayDialog("Prototeer definition", error.GetBaseException().Message, "Close");
                    }
                }
            DrawDefaultInspector();
        }
    }
}
