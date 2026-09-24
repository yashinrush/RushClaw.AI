/* ==========================================
   TASKFLOW PRO - JAVASCRIPT APPLICATION LOGIC
   ========================================== */

document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const taskListEl = document.getElementById('taskList');
    const emptyStateEl = document.getElementById('emptyState');
    const taskModal = document.getElementById('taskModal');
    const openModalBtn = document.getElementById('openModalBtn');
    const emptyAddBtn = document.getElementById('emptyAddBtn');
    const closeModalBtn = document.getElementById('closeModalBtn');
    const cancelModalBtn = document.getElementById('cancelModalBtn');
    const taskForm = document.getElementById('taskForm');
    const modalTitle = document.getElementById('modalTitle');
    const taskIdInput = document.getElementById('taskId');
    const taskTitleInput = document.getElementById('taskTitleInput');
    const taskCategorySelect = document.getElementById('taskCategorySelect');
    const taskPrioritySelect = document.getElementById('taskPrioritySelect');
    const taskDueDateInput = document.getElementById('taskDueDateInput');
    const taskDescInput = document.getElementById('taskDescInput');
    
    // Header & User Elements
    const currentDayEl = document.getElementById('currentDay');
    const currentDateEl = document.getElementById('currentDate');
    const usernameDisplay = document.getElementById('usernameDisplay');
    const editNameBtn = document.getElementById('editNameBtn');
    
    // Search & Filter Elements
    const searchInput = document.getElementById('searchInput');
    const sortSelect = document.getElementById('sortSelect');
    const tabBtns = document.querySelectorAll('.tab-btn');
    const categoryItems = document.querySelectorAll('.cat-item');

    // Stats & Progress Elements
    const progressBar = document.getElementById('progressBar');
    const taskStatsText = document.getElementById('taskStatsText');
    const taskPercentage = document.getElementById('taskPercentage');
    
    // Badges
    const badgeAll = document.getElementById('badgeAll');
    const badgeWork = document.getElementById('badgeWork');
    const badgePersonal = document.getElementById('badgePersonal');
    const badgeShopping = document.getElementById('badgeShopping');
    const badgeHealth = document.getElementById('badgeHealth');

    // Theme & Toast
    const themeToggleBtn = document.getElementById('themeToggleBtn');
    const toast = document.getElementById('toast');
    const toastMessage = document.getElementById('toastMessage');

    // Bulk Actions
    const bulkActionsBar = document.getElementById('bulkActionsBar');
    const selectedCountEl = document.getElementById('selectedCount');
    const completeSelectedBtn = document.getElementById('completeSelectedBtn');
    const deleteSelectedBtn = document.getElementById('deleteSelectedBtn');

    // App State
    let tasks = JSON.parse(localStorage.getItem('taskflow_tasks')) || [
        {
            id: '1',
            title: 'Design new landing page UI',
            category: 'Work',
            priority: 'high',
            dueDate: getFormattedDate(1),
            description: 'Create wireframes and high-fidelity mockups in Figma for Q3 product launch.',
            completed: false,
            createdAt: new Date(Date.now() - 3600000 * 5).toISOString()
        },
        {
            id: '2',
            title: 'Weekly grocery shopping',
            category: 'Shopping',
            priority: 'medium',
            dueDate: getFormattedDate(0),
            description: 'Buy organic vegetables, almond milk, coffee beans, and fresh fruits.',
            completed: true,
            createdAt: new Date(Date.now() - 3600000 * 24).toISOString()
        },
        {
            id: '3',
            title: 'Morning workout & stretching',
            category: 'Health',
            priority: 'low',
            dueDate: getFormattedDate(2),
            description: '30 minutes cardio and full body stretching routine.',
            completed: false,
            createdAt: new Date(Date.now() - 3600000 * 48).toISOString()
        }
    ];

    let username = localStorage.getItem('taskflow_username') || 'Productive User';
    let currentCategory = 'all';
    let currentStatus = 'all';
    let searchQuery = '';
    let currentSort = 'dueDate';
    let selectedTaskIds = new Set();
    let isDarkMode = localStorage.getItem('taskflow_darkmode') === 'true';

    // Initialize App
    initApp();

    function initApp() {
        // Set Username
        usernameDisplay.textContent = username;

        // Set Theme
        if (isDarkMode) {
            document.documentElement.setAttribute('data-theme', 'dark');
            themeToggleBtn.innerHTML = `<i class="fa-solid fa-sun"></i> <span>Light Mode</span>`;
        }

        // Set Date Header
        updateDateHeader();

        // Render everything
        renderTasks();
        updateStats();

        // Event Listeners
        setupEventListeners();
    }

    function getFormattedDate(daysOffset = 0) {
        const d = new Date();
        d.setDate(d.getDate() + daysOffset);
        return d.toISOString().split('T')[0];
    }

    function updateDateHeader() {
        const optionsDay = { weekday: 'long' };
        const optionsDate = { month: 'long', day: 'numeric', year: 'numeric' };
        const now = new Date();
        currentDayEl.textContent = now.toLocaleDateString('en-US', optionsDay);
        currentDateEl.textContent = now.toLocaleDateString('en-US', optionsDate);
    }

    function setupEventListeners() {
        // Modal Open / Close
        openModalBtn.addEventListener('click', () => openTaskModal());
        emptyAddBtn.addEventListener('click', () => openTaskModal());
        closeModalBtn.addEventListener('click', closeTaskModal);
        cancelModalBtn.addEventListener('click', closeTaskModal);
        taskModal.addEventListener('click', (e) => {
            if (e.target === taskModal) closeTaskModal();
        });

        // Form Submit
        taskForm.addEventListener('submit', handleTaskFormSubmit);

        // Search
        searchInput.addEventListener('input', (e) => {
            searchQuery = e.target.value.trim().toLowerCase();
            renderTasks();
        });

        // Sort
        sortSelect.addEventListener('change', (e) => {
            currentSort = e.target.value;
            renderTasks();
        });

        // Category Filter
        categoryItems.forEach(item => {
            item.addEventListener('click', () => {
                categoryItems.forEach(i => i.classList.remove('active'));
                item.classList.add('active');
                currentCategory = item.getAttribute('data-category');
                renderTasks();
            });
        });

        // Status Tabs Filter
        tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                tabBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentStatus = btn.getAttribute('data-status');
                renderTasks();
            });
        });

        // Theme Toggle
        themeToggleBtn.addEventListener('click', toggleTheme);

        // Edit Username
        editNameBtn.addEventListener('click', () => {
            const newName = prompt('Enter your name:', username);
            if (newName && newName.trim() !== '') {
                username = newName.trim();
                localStorage.setItem('taskflow_username', username);
                usernameDisplay.textContent = username;
                showToast('Username updated successfully!');
            }
        });

        // Bulk Actions
        completeSelectedBtn.addEventListener('click', () => {
            tasks.forEach(task => {
                if (selectedTaskIds.has(task.id)) {
                    task.completed = true;
                }
            });
            saveAndRefresh();
            clearSelection();
            showToast('Selected tasks marked as completed');
        });

        deleteSelectedBtn.addEventListener('click', () => {
            if (confirm(`Are you sure you want to delete ${selectedTaskIds.size} selected tasks?`)) {
                tasks = tasks.filter(task => !selectedTaskIds.has(task.id));
                saveAndRefresh();
                clearSelection();
                showToast('Selected tasks deleted');
            }
        });
    }

    // Modal Functions
    function openTaskModal(task = null) {
        taskForm.reset();
        if (task) {
            modalTitle.textContent = 'Edit Task';
            taskIdInput.value = task.id;
            taskTitleInput.value = task.title;
            taskCategorySelect.value = task.category;
            taskPrioritySelect.value = task.priority;
            taskDueDateInput.value = task.dueDate || '';
            taskDescInput.value = task.description || '';
        } else {
            modalTitle.textContent = 'Create New Task';
            taskIdInput.value = '';
            taskDueDateInput.value = getFormattedDate(0); // Default to today
        }
        taskModal.classList.add('active');
        taskTitleInput.focus();
    }

    function closeTaskModal() {
        taskModal.classList.remove('active');
    }

    // Handle Form Submit (Create or Update)
    function handleTaskFormSubmit(e) {
        e.preventDefault();
        const id = taskIdInput.value;
        const title = taskTitleInput.value.trim();
        const category = taskCategorySelect.value;
        const priority = taskPrioritySelect.value;
        const dueDate = taskDueDateInput.value;
        const description = taskDescInput.value.trim();

        if (!title) return;

        if (id) {
            // Edit existing
            tasks = tasks.map(task => {
                if (task.id === id) {
                    return { ...task, title, category, priority, dueDate, description };
                }
                return task;
            });
            showToast('Task updated successfully!');
        } else {
            // Create new
            const newTask = {
                id: Date.now().toString(),
                title,
                category,
                priority,
                dueDate,
                description,
                completed: false,
                createdAt: new Date().toISOString()
            };
            tasks.unshift(newTask);
            showToast('Task created successfully!');
        }

        saveAndRefresh();
        closeTaskModal();
    }

    // Delete Task
    window.deleteTask = function(id) {
        if (confirm('Are you sure you want to delete this task?')) {
            tasks = tasks.filter(task => task.id !== id);
            selectedTaskIds.delete(id);
            saveAndRefresh();
            showToast('Task deleted');
        }
    }

    // Toggle Task Complete Status
    window.toggleTaskComplete = function(id) {
        tasks = tasks.map(task => {
            if (task.id === id) {
                return { ...task, completed: !task.completed };
            }
            return task;
        });
        saveAndRefresh();
    }

    // Edit Task helper
    window.editTask = function(id) {
        const task = tasks.find(t => t.id === id);
        if (task) {
            openTaskModal(task);
        }
    }

    // Filter, Sort and Render Tasks
    function renderTasks() {
        let filtered = tasks.filter(task => {
            // Category filter
            if (currentCategory !== 'all' && task.category !== currentCategory) {
                return false;
            }
            // Status filter
            if (currentStatus === 'active' && task.completed) return false;
            if (currentStatus === 'completed' && !task.completed) return false;
            
            // Search query filter
            if (searchQuery) {
                const matchTitle = task.title.toLowerCase().includes(searchQuery);
                const matchDesc = task.description && task.description.toLowerCase().includes(searchQuery);
                if (!matchTitle && !matchDesc) return false;
            }

            return true;
        });

        // Sorting
        filtered.sort((a, b) => {
            if (currentSort === 'dueDate') {
                if (!a.dueDate) return 1;
                if (!b.dueDate) return -1;
                return new Date(a.dueDate) - new Date(b.dueDate);
            } else if (currentSort === 'priority') {
                const pMap = { high: 1, medium: 2, low: 3 };
                return pMap[a.priority] - pMap[b.priority];
            } else if (currentSort === 'alphabetical') {
                return a.title.localeCompare(b.title);
            } else if (currentSort === 'created') {
                return new Date(b.createdAt) - new Date(a.createdAt);
            }
            return 0;
        });

        // Render HTML
        if (filtered.length === 0) {
            taskListEl.innerHTML = '';
            emptyStateEl.classList.remove('hidden');
        } else {
            emptyStateEl.classList.add('hidden');
            taskListEl.innerHTML = filtered.map(task => {
                const isSelected = selectedTaskIds.has(task.id);
                const categoryClass = `badge-${task.category.toLowerCase()}`;
                const todayStr = getFormattedDate(0);
                const isOverdue = task.dueDate && task.dueDate < todayStr && !task.completed;
                
                let formattedDueDate = '';
                if (task.dueDate) {
                    if (task.dueDate === todayStr) formattedDueDate = 'Today';
                    else if (task.dueDate === getFormattedDate(1)) formattedDueDate = 'Tomorrow';
                    else formattedDueDate = new Date(task.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                }

                return `
                    <div class="task-item ${task.completed ? 'completed' : ''}" data-id="${task.id}">
                        <div class="task-left">
                            <input type="checkbox" class="task-checkbox" ${task.completed ? 'checked' : ''} onchange="toggleTaskComplete('${task.id}')">
                            <div class="task-content">
                                <div class="task-header-row">
                                    <span class="priority-indicator priority-${task.priority}" title="Priority: ${task.priority}"></span>
                                    <h4 class="task-title-text">${escapeHtml(task.title)}</h4>
                                    <span class="task-badge ${categoryClass}">${task.category}</span>
                                </div>
                                ${task.description ? `<p class="task-details-text">${escapeHtml(task.description)}</p>` : ''}
                                <div class="task-meta">
                                    ${task.dueDate ? `
                                        <span class="task-due-date ${isOverdue ? 'overdue' : ''}">
                                            <i class="fa-regular fa-calendar"></i> ${isOverdue ? 'Overdue: ' : ''}${formattedDueDate}
                                        </span>
                                    ` : ''}
                                </div>
                            </div>
                        </div>
                        <div class="task-actions">
                            <button class="action-btn" onclick="editTask('${task.id}')" title="Edit Task"><i class="fa-solid fa-pen"></i></button>
                            <button class="action-btn delete-btn" onclick="deleteTask('${task.id}')" title="Delete Task"><i class="fa-solid fa-trash"></i></button>
                            <input type="checkbox" class="task-select-checkbox" style="margin-left: 8px; cursor: pointer;" ${isSelected ? 'checked' : ''} onchange="toggleSelectTask('${task.id}')" title="Select for bulk action">
                        </div>
                    </div>
                `;
            }).join('');
        }

        updateCategoryBadges();
    }

    // Bulk selection helper
    window.toggleSelectTask = function(id) {
        if (selectedTaskIds.has(id)) {
            selectedTaskIds.delete(id);
        } else {
            selectedTaskIds.add(id);
        }
        updateBulkBar();
    }

    function clearSelection() {
        selectedTaskIds.clear();
        updateBulkBar();
        renderTasks();
    }

    function updateBulkBar() {
        if (selectedTaskIds.size > 0) {
            bulkActionsBar.classList.add('visible');
            selectedCountEl.textContent = `${selectedTaskIds.size} task${selectedTaskIds.size > 1 ? 's' : ''} selected`;
        } else {
            bulkActionsBar.classList.remove('visible');
        }
    }

    function updateStats() {
        const total = tasks.length;
        const completed = tasks.filter(t => t.completed).length;
        const percentage = total === 0 ? 0 : Math.round((completed / total) * 100);

        progressBar.style.width = `${percentage}%`;
        taskStatsText.textContent = `${completed} of ${total} completed`;
        taskPercentage.textContent = `${percentage}%`;
    }

    function updateCategoryBadges() {
        badgeAll.textContent = tasks.length;
        badgeWork.textContent = tasks.filter(t => t.category === 'Work').length;
        badgePersonal.textContent = tasks.filter(t => t.category === 'Personal').length;
        badgeShopping.textContent = tasks.filter(t => t.category === 'Shopping').length;
        badgeHealth.textContent = tasks.filter(t => t.category === 'Health').length;
    }

    function saveAndRefresh() {
        localStorage.setItem('taskflow_tasks', JSON.stringify(tasks));
        renderTasks();
        updateStats();
    }

    // Toggle Theme
    function toggleTheme() {
        isDarkMode = !isDarkMode;
        localStorage.setItem('taskflow_darkmode', isDarkMode);
        if (isDarkMode) {
            document.documentElement.setAttribute('data-theme', 'dark');
            themeToggleBtn.innerHTML = `<i class="fa-solid fa-sun"></i> <span>Light Mode</span>`;
        } else {
            document.documentElement.removeAttribute('data-theme');
            themeToggleBtn.innerHTML = `<i class="fa-solid fa-moon"></i> <span>Dark Mode</span>`;
        }
    }

    // Toast Notification helper
    function showToast(message) {
        toastMessage.textContent = message;
        toast.classList.add('show');
        setTimeout(() => {
            toast.classList.remove('show');
        }, 3000);
    }

    // Security helper
    function escapeHtml(str) {
        if (!str) return '';
        return str
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
});
