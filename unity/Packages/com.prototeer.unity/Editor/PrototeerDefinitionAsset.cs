using Unity.Behavior;
using UnityEngine;

namespace Prototeer.Unity.Editor
{
    public sealed class PrototeerDefinitionAsset : ScriptableObject
    {
        [SerializeField] private TextAsset source;
        [SerializeField] private string definitionId;
        [SerializeField] private BehaviorGraph graph;

        public TextAsset Source => source;
        public string DefinitionId => definitionId;
        public BehaviorGraph Graph => graph;

        internal void Initialize(TextAsset importSource, string id, BehaviorGraph runtimeGraph)
        {
            source = importSource;
            definitionId = id;
            graph = runtimeGraph;
        }
    }
}
