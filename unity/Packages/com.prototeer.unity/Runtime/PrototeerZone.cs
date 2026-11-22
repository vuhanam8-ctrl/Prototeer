using System;
using UnityEngine;
using UnityEngine.AI;

namespace Prototeer.Unity
{
    [DisallowMultipleComponent]
    [AddComponentMenu("Prototeer/Scene Zone")]
    public sealed class PrototeerZone : MonoBehaviour
    {
        [SerializeField, Tooltip("Paste the zone ID from the imported Prototeer definition.")]
        private string zoneId;
        [SerializeField, Tooltip("Names of the baked NavMesh areas belonging to this movement zone.")]
        private string[] navMeshAreaNames = Array.Empty<string>();
        [SerializeField, HideInInspector] private int configuredAreaMask;
        [SerializeField, Tooltip("Scene positions that can be chosen as destinations in this zone.")]
        private Transform[] markers = Array.Empty<Transform>();

        public string ZoneId => zoneId;
        internal Transform[] Markers => markers ?? Array.Empty<Transform>();
        internal int AreaMask
        {
            get
            {
                if (navMeshAreaNames == null || navMeshAreaNames.Length == 0)
                    return configuredAreaMask == NavMesh.AllAreas ? 0 : configuredAreaMask;
                int mask = 0;
                foreach (var name in navMeshAreaNames)
                {
                    int index = string.IsNullOrWhiteSpace(name) ? -1 : NavMesh.GetAreaFromName(name);
                    if (index < 0 || index == 1) // Not Walkable
                        return 0;
                    mask |= 1 << index;
                }
                return mask == NavMesh.AllAreas ? 0 : mask;
            }
        }

        public void Configure(string id, int areaMask, Transform[] sceneMarkers)
        {
            zoneId = id;
            configuredAreaMask = areaMask;
            navMeshAreaNames = Array.Empty<string>();
            markers = sceneMarkers != null ? (Transform[])sceneMarkers.Clone() : Array.Empty<Transform>();
        }

        public void ConfigureNames(string id, string[] areaNames, Transform[] sceneMarkers)
        {
            Configure(id, 0, sceneMarkers);
            navMeshAreaNames = areaNames != null ? (string[])areaNames.Clone() : Array.Empty<string>();
        }
    }
}
