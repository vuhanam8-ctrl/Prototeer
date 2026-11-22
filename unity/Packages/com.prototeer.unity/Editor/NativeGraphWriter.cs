using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Unity.Behavior;
using UnityEditor;
using UnityEngine;

namespace Prototeer.Unity.Editor
{
    internal static class NativeGraphWriter
    {
        private const BindingFlags Flags = BindingFlags.Public | BindingFlags.NonPublic
            | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
        private const BindingFlags StaticFlags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static;

        internal static BehaviorGraph Create(JToken definition, JObject document, string path)
        {
            var types = Assembly.Load("Unity.Behavior.Authoring");
            var graph = ScriptableObject.CreateInstance(types.GetType("Unity.Behavior.BehaviorAuthoringGraph", true));
            AssetDatabase.CreateAsset(graph, path);
            Call(graph, "ValidateAsset");
            var start = ((IEnumerable)Member(graph, "Nodes")).Cast<object>().Single();

            var nodes = definition["brain"].ToDictionary(node => (string)node["id"], StringComparer.Ordinal);
            var children = definition["edges"].ToLookup(edge => (string)edge[0], edge => (string)edge[1],
                StringComparer.Ordinal);
            var positions = Layout(children);
            FindField(start.GetType(), "Position").SetValue(start, new Vector2(positions["root"].x, 0));
            FindField(start.GetType(), "Repeat").SetValue(start, false);
            FindField(start.GetType(), "AllowMultipleRepeatsPerTick").SetValue(start, false);
            var models = nodes.ToDictionary(pair => pair.Key, pair =>
                WriteNode(graph, types, pair.Value, positions[pair.Key], definition, document), StringComparer.Ordinal);
            foreach (var pair in nodes.Where(pair => (string)pair.Value["type"] == "utility"))
            {
                var scores = new JArray(children[pair.Key].Select(id => new JObject
                {
                    // Scores belong to branches, even if their positions or connections are edited.
                    ["node"] = Member(models[id], "ID").ToString(),
                    ["stat"] = (string)nodes[id]["scoreStat"] ?? (string)nodes[id]["stat"] ?? "",
                    ["direction"] = (string)nodes[id]["direction"] ?? "low",
                    ["weight"] = (double?)nodes[id]["weight"] ?? 1,
                }));
                Set(models[pair.Key], nameof(UtilityNode.ScoresJson), scores.ToString(Formatting.None));
            }

            var clock = AddNode(graph, types, typeof(ClockNode), new Vector2(positions["root"].x, 200));
            Connect(graph, start, clock);
            Connect(graph, clock, models["root"]);
            foreach (var edge in definition["edges"])
                Connect(graph, models[(string)edge[0]], models[(string)edge[1]]);
            Call(graph, "ValidateAsset");
            Call(graph, "RebuildGraphAndBlackboardRuntimeData");
            var runtime = AssetDatabase.LoadAllAssetsAtPath(path).OfType<BehaviorGraph>().SingleOrDefault();
            if (runtime == null || Member(runtime, "RootGraph") == null)
                throw new InvalidDataException($"Unity did not compile Behavior Graph for '{(string)definition["name"]}'.");
            EditorUtility.SetDirty(graph);
            AssetDatabase.SaveAssetIfDirty(graph);
            AssetDatabase.SaveAssetIfDirty(runtime);
            return runtime;
        }

        private static Dictionary<string, Vector2> Layout(ILookup<string, string> children)
        {
            // Unity compiles siblings left to right. Give each subtree its own horizontal span.
            var positions = new Dictionary<string, Vector2>(StringComparer.Ordinal);
            var columns = 0;
            Place("root", 2);
            return positions;

            float Place(string id, int depth)
            {
                var positionsInBranch = children[id].Select(child => Place(child, depth + 1)).ToArray();
                var x = positionsInBranch.Length == 0 ? 420 * columns++ :
                    (positionsInBranch[0] + positionsInBranch[^1]) / 2;
                positions.Add(id, new Vector2(x, 200 * depth));
                return x;
            }
        }

        private static object WriteNode(UnityEngine.Object graph, Assembly authoring, JToken node,
            Vector2 position, JToken definition, JObject document)
        {
            switch ((string)node["type"])
            {
                case "utility":
                {
                    var model = AddNode(graph, authoring, typeof(UtilityNode), position);
                    Set(model, nameof(UtilityNode.Commit), (bool?)node["commitRunning"] ?? false);
                    Set(model, nameof(UtilityNode.CommitTicks), (int?)node["commitTicks"] ?? 120);
                    Set(model, nameof(UtilityNode.InterruptMargin), (double?)node["interruptMargin"] ?? 1);
                    return model;
                }
                case "selector":
                    return AddNode(graph, authoring, typeof(SelectorNode), position);
                case "sequence":
                {
                    var model = AddNode(graph, authoring, typeof(SequenceNode), position);
                    Set(model, nameof(SequenceNode.ResetOnInterrupt), (bool?)node["resetOnInterrupt"] ?? true);
                    return model;
                }
                case "condition":
                {
                    var model = AddNode(graph, authoring, typeof(ConditionNode), position);
                    Set(model, nameof(ConditionNode.Kind), (string)node["condition"]);
                    Set(model, nameof(ConditionNode.TagId), (string)node["tag"] ?? "");
                    Set(model, nameof(ConditionNode.TagPresent), (string)node["tagMode"] != "absent");
                    Set(model, nameof(ConditionNode.StatId), (string)node["stat"] ?? "");
                    Set(model, nameof(ConditionNode.Operator), (string)node["op"] ?? ">=");
                    Set(model, nameof(ConditionNode.Threshold), (double?)node["threshold"] ?? 0);
                    return model;
                }
            }

            switch ((string)node["action"])
            {
                case "idle":
                    return AddNode(graph, authoring, typeof(IdleNode), position);
                case "wait":
                {
                    var model = AddNode(graph, authoring, typeof(WaitNode), position);
                    Set(model, nameof(WaitNode.Minimum), (int?)node["waitMin"] ?? 2);
                    Set(model, nameof(WaitNode.Maximum), (int?)node["waitMax"] ?? 6);
                    Set(model, nameof(WaitNode.ResetOnInterrupt), (bool?)node["resetOnInterrupt"] ?? true);
                    return model;
                }
                case "rule":
                {
                    var model = AddNode(graph, authoring, typeof(RuleNode), position);
                    var ruleId = (string)node["ruleId"];
                    Set(model, nameof(RuleNode.RuleId), ruleId);
                    Set(model, nameof(RuleNode.NoopSuccess), (bool?)node["ruleNoopSuccess"] ?? false);
                    Set(model, nameof(RuleNode.RuleName),
                        (string)definition["rules"].Single(rule => (string)rule["id"] == ruleId)["name"] ?? ruleId);
                    return model;
                }
                case "chooseTarget":
                {
                    var model = AddNode(graph, authoring, typeof(ChoosePointNode), position);
                    var zoneIds = node["selectionZones"];
                    Set(model, nameof(ChoosePointNode.ZoneIdsJson), zoneIds.ToString(Formatting.None));
                    Set(model, nameof(ChoosePointNode.Slot), (string)node["slot"] ?? "destination");
                    Set(model, nameof(ChoosePointNode.MinimumTravel), (float?)node["minTravel"] ?? 0);
                    Set(model, nameof(ChoosePointNode.KeepTarget), (string)node["choosePolicy"] == "keep");
                    Set(model, nameof(ChoosePointNode.ZoneNames), string.Join(", ",
                        zoneIds.Values<string>().Select(id =>
                            (string)document["zones"].Single(zone => (string)zone["id"] == id)["name"] ?? id)));
                    return model;
                }
                case "moveTarget":
                {
                    var model = AddNode(graph, authoring, typeof(MoveToPointNode), position);
                    Set(model, nameof(MoveToPointNode.Slot), (string)node["slot"] ?? "destination");
                    return model;
                }
                default:
                    throw new InvalidDataException($"Unsupported behavior node '{(string)node["label"]}'.");
            }
        }

        private static object AddNode(UnityEngine.Object graph, Assembly authoring, Type runtimeType, Vector2 position)
        {
            var registry = authoring.GetType("Unity.Behavior.NodeRegistry", true);
            var lookup = registry.GetMethod("GetInfo", StaticFlags, null, new[] { typeof(Type) }, null);
            var info = lookup?.Invoke(null, new object[] { runtimeType });
            if (info == null)
                throw new InvalidOperationException("Unity Behavior did not register " + runtimeType.Name + ".");
            var model = Member(info, "ModelType");
            var modelType = (Type)model.GetType().GetMethod("op_Implicit", StaticFlags, null,
                new[] { model.GetType() }, null).Invoke(null, new[] { model });
            return Call(graph, "CreateNode", modelType, position, null, new[] { info });
        }

        private static void Connect(UnityEngine.Object graph, object parent, object child)
        {
            var output = Call(parent, "FindPortModelByName", "OutputPort");
            var input = Call(child, "FindPortModelByName", "InputPort");
            if (input == null || output == null)
                throw new InvalidDataException("An imported node does not have the required Unity Behavior ports.");
            Call(graph, "ConnectEdge", output, input);
        }

        private static void Set<T>(object node, string field, T value) => Methods(node.GetType(), "SetField")
            .Single(method => method.IsGenericMethodDefinition).MakeGenericMethod(typeof(T))
            .Invoke(node, new object[] { field, value });

        private static object Call(object target, string name, params object[] arguments) =>
            Methods(target.GetType(), name).First(method => method.GetParameters().Length == arguments.Length)
                .Invoke(target, arguments);

        private static IEnumerable<MethodInfo> Methods(Type type, string name)
        {
            for (; type != null; type = type.BaseType)
                foreach (var method in type.GetMethods(Flags))
                    if (method.Name == name)
                        yield return method;
        }

        private static object Member(object target, string name)
        {
            for (var type = target.GetType(); type != null; type = type.BaseType)
            {
                var property = type.GetProperty(name, Flags);
                if (property != null)
                    return property.GetValue(target);
                var field = type.GetField(name, Flags);
                if (field != null)
                    return field.GetValue(target);
            }
            throw new MissingMemberException(target.GetType().FullName, name);
        }

        private static FieldInfo FindField(Type type, string name)
        {
            for (; type != null; type = type.BaseType)
            {
                var field = type.GetField(name, Flags);
                if (field != null)
                    return field;
            }
            return null;
        }
    }
}
